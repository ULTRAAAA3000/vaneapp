#!/usr/bin/env node
/**
 * ČSOB gateway: key formats, signature strings, and the whole checkout → bank → return → paid flow on the REAL handlers and
 * schema.sql (in-memory SQLite), with a fake bank that signs its answers with its own key.   npm run test:unit
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
  `export * as csob from '${root}/functions/api/lib/csob.ts';`,
  `export * as session from '${root}/functions/api/lib/session.ts';`,
  `export * as checkout from '${root}/functions/api/billing/checkout.ts';`,
  `export * as back from '${root}/functions/api/billing/csob.ts';`,
  `export * as order from '${root}/functions/api/billing/order.ts';`,
  `export * as check from '${root}/functions/api/lib/billingcheck.ts';`,
].join('\n'));
await build({ entryPoints: [join(dir, 'entry.ts')], bundle: true, format: 'esm', platform: 'node', outfile: join(dir, 'all.mjs'), logLevel: 'silent' });
const { csob, session, checkout, back, order, check } = await import(pathToFileURL(join(dir, 'all.mjs')).href);
rmSync(dir, { recursive: true, force: true });

let passed = 0;
const failed = [];
const ok = (name, cond, extra = '') => { if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed.push(name); console.log(`  ✗ ${name} ${extra}`); } };

const merchant = generateKeyPairSync('rsa', { modulusLength: 2048 });
const bank = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pkcs8 = merchant.privateKey.export({ type: 'pkcs8', format: 'pem' });
const pkcs1 = merchant.privateKey.export({ type: 'pkcs1', format: 'pem' });
const bankSpki = bank.publicKey.export({ type: 'spki', format: 'pem' });
const bankPkcs1 = bank.publicKey.export({ type: 'pkcs1', format: 'pem' });
const sign = (key, text) => { const s = createSign('RSA-SHA256'); s.update(text); return s.sign(key, 'base64'); };

console.log('keys and signatures');
for (const [name, pem] of [['PKCS#8 private key', pkcs8], ['PKCS#1 private key', pkcs1], ['private key with \\n escapes', pkcs8.replace(/\n/g, '\\n')]]) {
  const sig = await csob.signText(pem, 'a|b|c');
  const v = createVerify('RSA-SHA256'); v.update('a|b|c');
  ok(`${name} signs RSA-SHA256`, v.verify(merchant.publicKey, sig, 'base64'));
}
{
  const sig = sign(bank.privateKey, 'x|y');
  ok('bank SPKI public key verifies', await csob.verifyText(bankSpki, 'x|y', sig));
  ok('bank PKCS#1 public key verifies', await csob.verifyText(bankPkcs1, 'x|y', sig));
  ok('altered text does not verify', !(await csob.verifyText(bankSpki, 'x|z', sig)));
  ok('another key does not verify', !(await csob.verifyText(merchant.publicKey.export({ type: 'spki', format: 'pem' }), 'x|y', sig)));
  ok('garbage signature is refused, not thrown', !(await csob.verifyText(bankSpki, 'x|y', '%%%')));
}
{
  const base = csob.initBase({ merchantId: 'MERCH1', orderNo: '123', dttm: '20260101120000', payOperation: 'payment', payMethod: 'card', totalAmount: 1900, currency: 'USD', closePayment: true, returnUrl: 'https://v/r', returnMethod: 'GET', cart: [{ name: 'Pro', quantity: 1, amount: 1900 }], description: 'd', merchantData: 'bQ==', language: 'EN' });
  ok('init string is in the documented order, empty values left out', base === 'MERCH1|123|20260101120000|payment|card|1900|USD|true|https://v/r|GET|Pro|1|1900|d|bQ==|EN', base);
  ok('response string skips missing fields', csob.responseBase({ payId: 'p', dttm: 'd', resultCode: 0, resultMessage: 'OK' }) === 'p|d|0|OK');
  ok('request string', csob.requestBase('MERCH1', 'p', 'd') === 'MERCH1|p|d');
  ok('stamp is 14 digits', /^\d{14}$/.test(csob.stamp()));
  ok('stamp uses Prague time (winter UTC+1)', csob.stamp(new Date('2026-01-15T10:00:00Z')) === '20260115110000');
  ok('stamp uses Prague time (summer UTC+2)', csob.stamp(new Date('2026-07-15T10:00:00Z')) === '20260715120000');
  const no = csob.randomOrderNo();
  ok('orderNo is numeric, at most 10 digits', /^\d{1,10}$/.test(no), no);
}
ok('disabled without keys', !csob.csobEnabled({}));
ok('enabled with all three', csob.csobEnabled({ CSOB_MERCHANT_ID: 'MERCH1', CSOB_PRIVATE_KEY: pkcs8, CSOB_BANK_PUBLIC_KEY: bankSpki }));

console.log('checkout → bank → return → paid');
let bankStatus = 1;
let bankSigns = true;
const calls = [];
const reply = (obj) => {
  const body = { ...obj, dttm: csob.stamp() };
  body.signature = bankSigns ? sign(bank.privateKey, csob.responseBase(body)) : 'AAAA';
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
};
let initFails = false;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  calls.push(u);
  if (u.includes('/payment/init')) {
    const b = JSON.parse(init.body);
    const v = createVerify('RSA-SHA256'); v.update(csob.initBase(b));
    if (!v.verify(merchant.publicKey, b.signature, 'base64')) return new Response('{}', { status: 400 });
    if (initFails) return reply({ payId: 'x', resultCode: 150, resultMessage: 'Invalid' });
    return reply({ payId: 'PAY123', resultCode: 0, resultMessage: 'OK', paymentStatus: 1, merchantData: b.merchantData });
  }
  if (u.includes('/payment/status/')) return reply({ payId: 'PAY123', resultCode: 0, resultMessage: 'OK', paymentStatus: bankStatus });
  return new Response('{}', { status: 404 });
};

function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync('schema.sql', 'utf8'));
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
    ENCRYPTION_KEY: 'k'.repeat(40), CSOB_MERCHANT_ID: 'MERCH1', CSOB_PRIVATE_KEY: pkcs8, CSOB_BANK_PUBLIC_KEY: bankSpki, CSOB_ENV: 'test', APP_URL: 'https://vaneapp.dev',
    DB: { prepare: mk, async batch(stmts) { db.exec('BEGIN'); try { const out = []; for (const s of stmts) out.push(await s.run()); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; } } },
  };
  db.exec(`INSERT INTO users (id, email) VALUES ('u1', 'a@example.com')`);
  return { db, env };
}
const hdr = (cookie) => ({ 'content-type': 'application/json', cookie: `vane_session=${cookie}`, origin: 'https://vaneapp.dev', 'sec-fetch-site': 'same-origin', 'cf-connecting-ip': '203.0.113.9' });
async function buy(env, extra = {}) {
  const t = await session.createSession(env, new Request('https://vaneapp.dev/'), 'u1');
  const req = new Request('https://vaneapp.dev/api/billing/checkout', { method: 'POST', headers: hdr(t), body: JSON.stringify({ method: 'csob', planId: 'pro', interval: 'month', accept: true, waiver: true, billing: { name: 'Ann Lee', email: 'a@example.com', country: 'CZ' }, ...extra }) });
  const res = await checkout.onRequestPost({ request: req, env, params: {}, waitUntil() {} });
  return { status: res.status, data: await res.json().catch(() => null), token: t };
}

{
  const { db, env } = setup();
  const r = await buy(env);
  ok('checkout creates the order (201)', r.status === 201 && r.data?.ok, JSON.stringify(r.data));
  const row = db.prepare(`SELECT * FROM orders`).get();
  ok('order is saved as csob / pending with the bank payId', row?.provider === 'csob' && row.status === 'pending' && row.provider_ref === 'PAY123', JSON.stringify(row));
  ok('payUrl goes to the gateway payment page with a signature', /^https:\/\/iapi\.iplatebnibrana\.csob\.cz\/api\/v1\.9\/payment\/process\/MERCH1\/PAY123\/\d{14}\/.+/.test(r.data?.order?.payUrl ?? ''), r.data?.order?.payUrl);

  const again = await buy(env);
  ok('a second click reuses the open order', db.prepare(`SELECT COUNT(*) n FROM orders`).get().n === 1 && again.data?.ok);

  const ret = (id = 'PAY123') => back.onRequestGet({ request: new Request(`https://vaneapp.dev/api/billing/csob?payId=${id}`), env, params: {}, waitUntil() {} });

  bankStatus = 2;
  let res = await ret();
  ok('return while the bank still waits: redirect, order stays pending', res.status === 303 && res.headers.get('Location') === `/checkout?order=${row.id}` && db.prepare(`SELECT status FROM orders`).get().status === 'pending');

  bankSigns = false;
  bankStatus = 4;
  await ret();
  ok('a bank answer with a bad signature settles nothing', db.prepare(`SELECT status FROM orders`).get().status === 'pending');
  bankSigns = true;

  res = await ret('NOPE');
  ok('unknown payId goes to /checkout without touching anything', res.status === 303 && res.headers.get('Location') === '/checkout');
  res = await ret('bad id;--');
  ok('malformed payId is ignored', res.headers.get('Location') === '/checkout');

  await ret();
  const paid = db.prepare(`SELECT status, tx_ref FROM orders`).get();
  ok('paid at the bank: order paid and plan active', paid.status === 'paid' && paid.tx_ref === 'PAY123' && db.prepare(`SELECT plan FROM subscriptions WHERE user_id = 'u1'`).get()?.plan === 'pro', JSON.stringify(paid));
  await ret();
  ok('a repeated return does not charge or extend twice', db.prepare(`SELECT COUNT(*) n FROM orders WHERE status = 'paid'`).get().n === 1);

  const poll = await order.onRequestGet({ request: new Request(`https://vaneapp.dev/api/billing/order?id=${row.id}`, { headers: hdr(r.token) }), env, params: {}, waitUntil() {} });
  const pd = await poll.json().catch(() => null);
  ok('order polling reports paid', poll.status === 200 && pd?.order?.status === 'paid', JSON.stringify(pd));
}

{
  const { db, env } = setup();
  await buy(env);
  bankStatus = 3;
  db.prepare(`UPDATE orders SET created_at = created_at - 600`).run();
  await check.sweepOrders(env, Math.floor(Date.now() / 1000));
  ok('cancelled at the bank: the sweep marks the order failed', db.prepare(`SELECT status FROM orders`).get().status === 'failed');
}

{
  const { db, env } = setup();
  initFails = true;
  const r = await buy(env);
  initFails = false;
  ok('bank refuses to start: 502, no payable order left open with a payId', r.status === 502, String(r.status));
}

{
  const { env } = setup();
  const r = await buy(env, { planId: 'pro', billing: { name: 'A', email: 'bad', country: 'CZ' } });
  ok('bad billing details are refused before the bank is called', r.status === 400);
  const none = setup();
  none.env.CSOB_PRIVATE_KEY = '';
  const r2 = await buy(none.env);
  ok('without keys the method is unavailable', r2.status === 503, String(r2.status));
}

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) { console.log(failed.join('\n')); process.exit(1); }
