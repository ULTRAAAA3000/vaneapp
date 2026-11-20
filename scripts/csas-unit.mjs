#!/usr/bin/env node
/**
 * Česká spořitelna's GP webpay gateway: key gating, the signed redirect URL, and the whole checkout → gateway → return → paid
 * flow on the REAL handlers and schema.sql (in-memory SQLite), with a fake gateway that signs its answers with its own key.
 * npm run test:unit
 */
import { build } from 'esbuild';
import { DatabaseSync } from 'node:sqlite';
import { generateKeyPairSync, createSign, createVerify } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'vane-unit-'));
const root = process.cwd();
writeFileSync(join(dir, 'entry.ts'), [
  `export * as csas from '${root}/functions/api/lib/csas.ts';`,
  `export * as session from '${root}/functions/api/lib/session.ts';`,
  `export * as checkout from '${root}/functions/api/billing/checkout.ts';`,
  `export * as back from '${root}/functions/api/billing/csas.ts';`,
].join('\n'));
await build({ entryPoints: [join(dir, 'entry.ts')], bundle: true, format: 'esm', platform: 'node', outfile: join(dir, 'all.mjs'), logLevel: 'silent' });
const { csas, session, checkout, back } = await import(pathToFileURL(join(dir, 'all.mjs')).href);
rmSync(dir, { recursive: true, force: true });

let passed = 0;
const failed = [];
const ok = (name, cond, extra = '') => { if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed.push(name); console.log(`  ✗ ${name} ${extra}`); } };

const merchant = generateKeyPairSync('rsa', { modulusLength: 2048 });
const bank = generateKeyPairSync('rsa', { modulusLength: 2048 });
const merchantPkcs8 = merchant.privateKey.export({ type: 'pkcs8', format: 'pem' });
const bankSpki = bank.publicKey.export({ type: 'spki', format: 'pem' });
const MERCHANT_NUMBER = '1234567890';

console.log('keys, gating, currencies');
ok('disabled without keys', !csas.csasEnabled({}));
ok('disabled with a bad merchant number', !csas.csasEnabled({ CSAS_MERCHANT_NUMBER: 'abc', CSAS_PRIVATE_KEY: merchantPkcs8, CSAS_BANK_PUBLIC_KEY: bankSpki }));
ok('enabled with all three', csas.csasEnabled({ CSAS_MERCHANT_NUMBER: MERCHANT_NUMBER, CSAS_PRIVATE_KEY: merchantPkcs8, CSAS_BANK_PUBLIC_KEY: bankSpki }));
ok('default currencies are CZK and EUR', [...csas.csasCurrencies({})].sort().join(',') === 'CZK,EUR');
ok('currencies follow CSAS_CURRENCIES', [...csas.csasCurrencies({ CSAS_CURRENCIES: 'czk,usd,gbp' })].sort().join(',') === 'CZK,GBP,USD');
ok('order numbers are numeric', /^\d+$/.test(csas.randomOrderNumber()));
ok('unsupported currency builds no URL', await csas.buildPaymentUrl({ CSAS_MERCHANT_NUMBER: MERCHANT_NUMBER, CSAS_PRIVATE_KEY: merchantPkcs8, CSAS_BANK_PUBLIC_KEY: bankSpki }, { orderNumber: '1', amountCents: 100, currency: 'XYZ', description: 'd', merchantData: 'm', returnUrl: 'https://v/r' }) === null);

console.log('signed redirect URL');
{
  const env = { CSAS_MERCHANT_NUMBER: MERCHANT_NUMBER, CSAS_PRIVATE_KEY: merchantPkcs8, CSAS_BANK_PUBLIC_KEY: bankSpki, CSAS_ENV: 'test' };
  const url = await csas.buildPaymentUrl(env, { orderNumber: '555000111', amountCents: 1900, currency: 'CZK', description: 'Vane Pro, one month', merchantData: 'order-1', returnUrl: 'https://vaneapp.dev/api/billing/csas' });
  ok('URL points at the test gateway', url?.startsWith('https://test.3dsecure.gpwebpay.com/pgw/order.do?'), url);
  const q = new URL(url).searchParams;
  ok('fields round-trip', q.get('MERCHANTNUMBER') === MERCHANT_NUMBER && q.get('ORDERNUMBER') === '555000111' && q.get('AMOUNT') === '1900' && q.get('CURRENCY') === '203' && q.get('DEPOSITFLAG') === '1' && q.get('OPERATION') === 'CREATE_ORDER');
  ok('MERORDERNUM is left out (never sent)', q.get('MERORDERNUM') === null);
  const expected = ['MERCHANTNUMBER', 'OPERATION', 'ORDERNUMBER', 'AMOUNT', 'CURRENCY', 'DEPOSITFLAG', 'URL', 'DESCRIPTION', 'MD'].map((k) => q.get(k)).join('|');
  const v = createVerify('RSA-SHA1'); v.update(expected);
  ok('DIGEST verifies against the merchant\'s own public key', v.verify(merchant.publicKey, q.get('DIGEST'), 'base64'));

  const envLive = { ...env, CSAS_ENV: 'live' };
  const live = await csas.buildPaymentUrl(envLive, { orderNumber: '2', amountCents: 100, currency: 'EUR', description: 'd', merchantData: 'm', returnUrl: 'https://v/r' });
  ok('CSAS_ENV=live points at the real gateway', live?.startsWith('https://3dsecure.gpwebpay.com/pgw/order.do?'), live);
}

console.log('checkout → gateway → return → paid');
const RESPONSE_FIELDS = ['OPERATION', 'ORDERNUMBER', 'MD', 'PRCODE', 'SRCODE', 'RESULTTEXT'];
function bankAnswer(fields) {
  const present = RESPONSE_FIELDS.filter((k) => fields[k] !== undefined);
  const values = present.map((k) => fields[k]);
  const sign = (text) => { const s = createSign('RSA-SHA1'); s.update(text); return s.sign(bank.privateKey, 'base64'); };
  const qs = new URLSearchParams();
  for (const k of present) qs.set(k, fields[k]);
  qs.set('DIGEST', sign(values.join('|')));
  qs.set('DIGEST1', sign([...values, MERCHANT_NUMBER].join('|')));
  return qs;
}

function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync('schema.sql', 'utf8'));
  db.exec(readFileSync('migrations/0006-orders-csas.sql', 'utf8'));
  const mk = (sql) => {
    let args = [];
    const st = {
      bind(...a) { args = a; return st; },
      async first() { return db.prepare(sql).get(...args) ?? null; },
      async run() { const r = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes) } }; },
      async all() { return { results: db.prepare(sql).all(...args) }; },
    };
    return st;
  };
  const env = {
    ENCRYPTION_KEY: 'k'.repeat(40), CSAS_MERCHANT_NUMBER: MERCHANT_NUMBER, CSAS_PRIVATE_KEY: merchantPkcs8, CSAS_BANK_PUBLIC_KEY: bankSpki, CSAS_ENV: 'test', CSAS_CURRENCIES: 'USD,CZK,EUR', APP_URL: 'https://vaneapp.dev',
    DB: { prepare: mk, async batch(stmts) { db.exec('BEGIN'); try { const out = []; for (const s of stmts) out.push(await s.run()); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; } } },
  };
  db.exec(`INSERT INTO users (id, email) VALUES ('u1', 'a@example.com')`);
  return { db, env };
}
const hdr = (cookie) => ({ 'content-type': 'application/json', cookie: `vane_session=${cookie}`, origin: 'https://vaneapp.dev', 'sec-fetch-site': 'same-origin', 'cf-connecting-ip': '203.0.113.9' });
async function buy(env, extra = {}) {
  const t = await session.createSession(env, new Request('https://vaneapp.dev/'), 'u1');
  const req = new Request('https://vaneapp.dev/api/billing/checkout', { method: 'POST', headers: hdr(t), body: JSON.stringify({ method: 'csas', planId: 'pro', interval: 'month', accept: true, waiver: true, billing: { name: 'Ann Lee', email: 'a@example.com', country: 'CZ' }, ...extra }) });
  const res = await checkout.onRequestPost({ request: req, env, params: {}, waitUntil() {} });
  return { status: res.status, data: await res.json().catch(() => null), token: t };
}

{
  const { db, env } = setup();
  const r = await buy(env);
  ok('checkout creates the order (201)', r.status === 201 && r.data?.ok, JSON.stringify(r.data));
  const row = db.prepare(`SELECT * FROM orders`).get();
  ok('order is saved as csas / pending with its own order number', row?.provider === 'csas' && row.status === 'pending' && /^\d+$/.test(row.provider_ref ?? ''), JSON.stringify(row));
  ok('payUrl goes to the test gateway, signed', row.pay_url?.startsWith('https://test.3dsecure.gpwebpay.com/pgw/order.do?') && row.pay_url.includes('DIGEST='), row.pay_url);

  const again = await buy(env);
  ok('a second click reuses the open order', db.prepare(`SELECT COUNT(*) n FROM orders`).get().n === 1 && again.data?.ok);

  const ret = (qs) => back.onRequestGet({ request: new Request(`https://vaneapp.dev/api/billing/csas?${qs.toString()}`), env, params: {}, waitUntil() {} });

  let res = await ret(bankAnswer({ OPERATION: 'CREATE_ORDER', ORDERNUMBER: row.provider_ref, MD: row.id, PRCODE: '14', SRCODE: '30', RESULTTEXT: 'Declined' }));
  ok('declined at the gateway: order marked failed, redirected to the order', res.status === 303 && res.headers.get('Location') === `/checkout?order=${row.id}` && db.prepare(`SELECT status FROM orders`).get().status === 'failed');

  db.exec(`UPDATE orders SET status = 'pending'`);
  const tampered = bankAnswer({ OPERATION: 'CREATE_ORDER', ORDERNUMBER: row.provider_ref, MD: row.id, PRCODE: '0', SRCODE: '0', RESULTTEXT: 'OK' });
  tampered.set('DIGEST', 'AAAA');
  await ret(tampered);
  ok('a reply with a bad DIGEST settles nothing', db.prepare(`SELECT status FROM orders`).get().status === 'pending');

  res = await ret(bankAnswer({ OPERATION: 'CREATE_ORDER', ORDERNUMBER: '000000000', MD: 'x', PRCODE: '0', SRCODE: '0', RESULTTEXT: 'OK' }));
  ok('unknown order number goes to /checkout without touching anything', res.status === 303 && res.headers.get('Location') === '/checkout' && db.prepare(`SELECT status FROM orders`).get().status === 'pending');

  await ret(bankAnswer({ OPERATION: 'CREATE_ORDER', ORDERNUMBER: row.provider_ref, MD: row.id, PRCODE: '0', SRCODE: '0', RESULTTEXT: 'OK' }));
  const paid = db.prepare(`SELECT status, tx_ref FROM orders`).get();
  ok('paid at the gateway: order paid and plan active', paid.status === 'paid' && paid.tx_ref === row.provider_ref && db.prepare(`SELECT plan FROM subscriptions WHERE user_id = 'u1'`).get()?.plan === 'pro', JSON.stringify(paid));

  await ret(bankAnswer({ OPERATION: 'CREATE_ORDER', ORDERNUMBER: row.provider_ref, MD: row.id, PRCODE: '0', SRCODE: '0', RESULTTEXT: 'OK' }));
  ok('a repeated return does not charge or extend twice', db.prepare(`SELECT COUNT(*) n FROM orders WHERE status = 'paid'`).get().n === 1);
}

{
  const { env } = setup();
  const r = await buy(env, { planId: 'pro', billing: { name: 'A', email: 'bad', country: 'CZ' } });
  ok('bad billing details are refused before the gateway URL is built', r.status === 400);
  const none = setup();
  none.env.CSAS_PRIVATE_KEY = '';
  const r2 = await buy(none.env);
  ok('without keys the method is unavailable', r2.status === 503, String(r2.status));
}

console.log('POST return (large answers)');
{
  const { db, env } = setup();
  const r = await buy(env);
  const row = db.prepare(`SELECT * FROM orders`).get();
  const qs = bankAnswer({ OPERATION: 'CREATE_ORDER', ORDERNUMBER: row.provider_ref, MD: row.id, PRCODE: '0', SRCODE: '0', RESULTTEXT: 'OK' });
  const res = await back.onRequestPost({ request: new Request('https://vaneapp.dev/api/billing/csas', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: qs.toString() }), env, params: {}, waitUntil() {} });
  ok('a POST return is accepted the same as GET', res.status === 303 && res.headers.get('Location') === `/checkout?order=${row.id}` && db.prepare(`SELECT status FROM orders`).get().status === 'paid');
}

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) { console.log(failed.join('\n')); process.exit(1); }
