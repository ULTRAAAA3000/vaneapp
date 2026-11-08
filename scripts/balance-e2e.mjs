#!/usr/bin/env node
/**
 * End-to-end test of the prepaid balance and the hard quota stop, over HTTP against a LOCAL dev server:
 * the dashboard stops at the quota, extra posts are paid from the balance, a top-up order is credited exactly once,
 * the admin can adjust a balance, and the pages and plans around it answer.
 *
 *   npm run db:local && npm run dev        (needs ADMIN_EMAIL + ADMIN_PASSWORD_HASH and CRYPTO_WALLET in .dev.vars)
 *   npm run test:balance                   (defaults: admin@example.com / Admin-Test-Pass-77, BASE=http://localhost:8788)
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const BASE = process.env.BASE ?? 'http://localhost:8788';
const ADMIN_LOGIN = process.env.ADMIN_TEST_LOGIN ?? 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_TEST_PASSWORD ?? 'Admin-Test-Pass-77';
let passed = 0; const failures = [];
const check = (n, c, x = '') => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failures.push(n); console.log(`  ✗ ${n} ${x}`); } };
const section = (t) => console.log(`\n${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(method, path, { cookie, body } = {}) {
  const init = { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined };
  let res;
  for (let a = 0; ; a++) { try { res = await fetch(BASE + path, init); break; } catch (e) { if (a >= 8) throw e; await sleep(750); } }
  let json = null; let text = null;
  const raw = await res.text();
  try { json = JSON.parse(raw); } catch { text = raw; }
  return { status: res.status, json, text, headers: res.headers };
}
const wr = (args) => spawnSync('npx', ['wrangler', 'd1', 'execute', 'vane-db', '--local', ...args], { encoding: 'utf8' });
const sql = (c) => { const r = wr(['--json', '--command', c]); if (r.status !== 0) throw new Error(r.stderr || r.stdout); return JSON.parse(r.stdout)[0].results; };
const setPlan = (email, plan, ...flags) => { const r = spawnSync('node', ['scripts/set-plan.mjs', email, plan, ...flags], { encoding: 'utf8' }); if (r.status !== 0) throw new Error('set-plan failed: ' + r.stderr); };
const inHours = (h) => new Date(Date.now() + h * 3600_000).toISOString().replace(/\.\d+Z$/, 'Z');
const month = () => new Date().toISOString().slice(0, 7);
const cookieOf = (res) => (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');

async function signUp(email) {
  const pw = 'Correct-Horse-9';
  const reg = await http('POST', '/api/auth/register', { body: { email, password: pw, name: 'E2E', timezone: 'UTC', birthDate: '1990-01-15' } });
  if (reg.status !== 201 && reg.status !== 200) throw new Error(`register failed: ${reg.status} ${JSON.stringify(reg.json)}`);
  const login = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: pw }) });
  return { email, cookie: cookieOf(login), id: sql(`SELECT id FROM users WHERE email = '${email}'`)[0].id };
}
const dash = (u, chan) => http('POST', '/api/posts', { cookie: u.cookie, body: { content: 'e2e dashboard post', channelIds: [chan], scheduledAt: inHours(3) } });
const balanceOf = async (u) => (await http('GET', '/api/balance', { cookie: u.cookie })).json?.balanceUsd;
const rowsBal = (u) => sql(`SELECT micro_usd AS m FROM user_balance WHERE user_id = '${u.id}'`)[0]?.m ?? 0;

try {
  if (!(await fetch(BASE + '/api/auth/config').catch(() => null))) { console.error(`Cannot reach ${BASE}. Start it with: npm run db:local && npm run dev`); process.exit(2); }
  sql('DELETE FROM rate_limits');

  // ── the page and the data around it
  section('The balance page and its data');
  const page = await http('GET', '/topup');
  check('/topup is served', page.status === 200 && /Add funds/.test(page.text ?? ''));
  check('/api/balance needs a session', (await http('GET', '/api/balance')).status === 401);
  const free = await signUp(`bal-free-${Date.now()}@example.com`);
  const chan = randomUUID();
  sql(`INSERT INTO channels (id, user_id, type, name, credentials) VALUES ('${chan}', '${free.id}', 'telegram', 'e2e channel', 'x')`);
  const b0 = await http('GET', '/api/balance', { cookie: free.cookie });
  check('a new account has $0, the range is $10–$500 with four presets, none of them $5', b0.json?.balanceUsd === 0 && b0.json?.min === 10 && b0.json?.max === 500 && JSON.stringify(b0.json?.presets) === '[10,25,50,100]');
  check('the Free Trial has no price for extra use, so there is nothing to switch on', b0.json?.extra?.available === false);
  check('/api/usage carries the balance and the hard-stop state', (await http('GET', '/api/usage', { cookie: free.cookie })).json?.usage?.limit?.reached === false);

  section('Top-up amounts are checked (plan lookup and checkout)');
  const p25 = await http('GET', '/api/billing/plan?id=balance&amount=25');
  check('a $25 top-up is offered as a one-off purchase', p25.status === 200 && p25.json?.plan?.priceCents === 2500 && p25.json?.plan?.interval === 'once');
  for (const bad of ['5', '9', '501', '12.5', 'abc', '']) check(`amount "${bad}" is refused`, (await http('GET', `/api/billing/plan?id=balance&amount=${bad}`)).status === 400);
  const buy = (amountUsd, extra = {}) => http('POST', '/api/billing/checkout', { cookie: free.cookie, body: { planId: 'balance', amountUsd, method: 'crypto', billing: { name: 'E2E Buyer', email: free.email, country: 'UA' }, accept: true, ...extra } });
  for (const bad of [3, 12.5, 501, 'x', undefined]) check(`checkout refuses amountUsd=${bad}`, (await buy(bad)).status === 400);
  check('checkout still needs the Terms ticked', (await buy(10, { accept: false })).status === 400);

  // ── hard stop on the Free Trial (30 posts in total, never charged)
  section('Free Trial: the dashboard stops at 30 posts');
  sql(`INSERT INTO usage_counters (user_id, period, ui_posts, api_posts) VALUES ('${free.id}', 'lifetime', 29, 0)`);
  const last = await dash(free, chan);
  check('the 30th post goes through', last.status === 201, `${last.status} ${last.json?.error ?? ''}`);
  const stop = await dash(free, chan);
  check('the 31st is a hard stop (402)', stop.status === 402 && stop.json?.code === 'quota_exceeded');
  check('…it never resets and says to choose a plan', /does not reset/i.test(stop.json?.error ?? '') && /Choose a plan/i.test(stop.json?.error ?? ''), stop.json?.error);
  check('…and points to the balance page', stop.json?.topUpUrl === '/topup' && stop.json?.resetsAt === null);
  const u1 = (await http('GET', '/api/usage', { cookie: free.cookie })).json?.usage;
  check('the dashboard banner has what it needs', u1?.limit?.reached === true && u1?.limit?.postsLeft === 0 && u1?.limit?.offersExtra === false);
  sql(`UPDATE usage_counters SET ui_posts = 25, api_posts = 0 WHERE user_id = '${free.id}' AND period = 'lifetime'`);
  const burst = await Promise.all(Array.from({ length: 12 }, () => dash(free, chan)));
  check('12 parallel posts with 5 left: exactly 5 go through', burst.filter((r) => r.status === 201).length === 5 && burst.filter((r) => r.status === 402).length === 7, burst.map((r) => r.status).join(','));

  // ── Pro: extra posts from the balance
  section('Pro: extra posts are paid from the balance');
  const pro = await signUp(`bal-pro-${Date.now()}@example.com`);
  const chanP = randomUUID();
  sql(`INSERT INTO channels (id, user_id, type, name, credentials) VALUES ('${chanP}', '${pro.id}', 'telegram', 'e2e pro', 'x')`);
  setPlan(pro.email, 'pro', '--days', '30');
  sql(`INSERT INTO usage_counters (user_id, period, ui_posts) VALUES ('${pro.id}', '${month()}', 1000)`);
  const s1 = await dash(pro, chanP);
  check('1000 used, switch off → 402 that says how to continue', s1.status === 402 && /add funds/i.test(s1.json?.error ?? '') && /switch on/i.test(s1.json?.error ?? '') && /resets on/i.test(s1.json?.error ?? ''), s1.json?.error);
  const on = await http('POST', '/api/usage/overage', { cookie: pro.cookie, body: { enabled: true } });
  check('Pro can switch on paying for extra use', on.status === 200 && on.json?.overage?.enabled === true, JSON.stringify(on.json));
  const s2 = await dash(pro, chanP);
  check('switched on but $0 → still 402: "balance is too low"', s2.status === 402 && /balance is too low/i.test(s2.json?.error ?? ''), s2.json?.error);
  check('…nothing was counted', sql(`SELECT ui_posts AS n FROM usage_counters WHERE user_id = '${pro.id}' AND period = '${month()}'`)[0].n === 1000);

  // ── a real top-up order, paid, credited once
  section('A top-up order: created, confirmed by an admin, credited exactly once');
  const order = await http('POST', '/api/billing/checkout', { cookie: pro.cookie, body: { planId: 'balance', amountUsd: 10, method: 'crypto', billing: { name: 'E2E Buyer', email: pro.email, country: 'UA' }, accept: true } });
  check('a $10 top-up order is created (pending, $10, one-off)', order.status === 200 || order.status === 201, `${order.status} ${JSON.stringify(order.json)?.slice(0, 200)}`);
  const orderId = order.json?.order?.id;
  check('the order is for "Balance top-up" and $10.00', order.json?.order?.planName === 'Balance top-up' && order.json?.order?.amountCents === 1000 && order.json?.order?.status === 'pending');
  const login = await fetch(BASE + '/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: ADMIN_LOGIN, password: ADMIN_PASSWORD }) });
  const admin = cookieOf(login);
  if (!admin) { console.error('Admin login failed: set ADMIN_EMAIL + ADMIN_PASSWORD_HASH in .dev.vars.'); process.exit(2); }
  const confirm = () => http('POST', '/api/admin/orders', { cookie: admin, body: { action: 'confirm', orderId } });
  const c1 = await confirm();
  check('the admin confirms the payment', c1.status === 200, `${c1.status} ${JSON.stringify(c1.json)}`);
  check('the balance is $10', (await balanceOf(pro)) === 10, String(await balanceOf(pro)));
  await Promise.all([confirm(), confirm(), confirm()]);
  check('confirming again, even in parallel, adds nothing', (await balanceOf(pro)) === 10, String(await balanceOf(pro)));
  const led = (await http('GET', '/api/balance', { cookie: pro.cookie })).json?.ledger ?? [];
  check('the history has the top-up once', led.filter((l) => l.kind === 'topup').length === 1 && led[0].usd === 10);
  check('Pro offers extra use: $0.015 per post and $0.045 per AI credit', (await http('GET', '/api/balance', { cookie: pro.cookie })).json?.extra?.postUsd === 0.015);

  section('…and now the extra post goes through, at $0.015');
  const s3 = await dash(pro, chanP);
  check('the extra post is created (201)', s3.status === 201, `${s3.status} ${s3.json?.error ?? ''}`);
  check('the balance is $9.985', rowsBal(pro) === 9_985_000, String(rowsBal(pro)));
  const u2 = (await http('GET', '/api/usage', { cookie: pro.cookie })).json?.usage;
  check('the usage says 1 extra post, $0.015, and no stop', u2?.overage?.posts === 1 && u2?.overage?.costUsd === 0.015 && u2?.limit?.reached === false, JSON.stringify(u2?.overage));
  const led2 = (await http('GET', '/api/balance', { cookie: pro.cookie })).json?.ledger ?? [];
  check('the history shows the spend (−$0.015)', led2[0]?.kind === 'charge' && led2[0]?.usd === -0.015 && led2[0]?.what === 'post', JSON.stringify(led2[0]));
  const rush = await Promise.all(Array.from({ length: 6 }, () => dash(pro, chanP)));
  check('6 parallel extra posts all go through and are all charged', rush.every((r) => r.status === 201) && rowsBal(pro) === 9_985_000 - 6 * 15_000, String(rowsBal(pro)));

  section('Switching off stops extra posts at once');
  await http('POST', '/api/usage/overage', { cookie: pro.cookie, body: { enabled: false } });
  const s4 = await dash(pro, chanP);
  check('switch off → 402 even with money on the balance', s4.status === 402 && /switch on/i.test(s4.json?.error ?? ''), s4.json?.error);
  check('…and the money is untouched', rowsBal(pro) === 9_985_000 - 6 * 15_000);

  // ── admin
  section('Admin: adjust a balance and see the extra usage');
  const adj = (amountUsd, note = 'e2e') => http('POST', '/api/admin/users', { cookie: admin, body: { action: 'balance', userId: pro.id, amountUsd, note } });
  const before = rowsBal(pro);
  const a1 = await adj(2.5);
  check('adding $2.50 by hand works', a1.status === 200 && rowsBal(pro) === before + 2_500_000, JSON.stringify(a1.json));
  check('taking away more than there is is refused', (await adj(-100000)).status === 400 && (await adj(-1000)).status === 409);
  check('an amount that is not whole cents is refused', (await adj(0.001)).status === 400);
  const ex = await http('GET', '/api/admin/extra-usage', { cookie: admin });
  const mine = (ex.json?.rows ?? []).find((r) => r.userId === pro.id);
  check('the extra-usage report shows this account: 7 extra posts, $0.105', ex.status === 200 && mine?.posts === 7 && Math.abs(mine?.postsUsd - 0.105) < 1e-9, JSON.stringify(mine));
  check('the account page shows the balance', (await http('GET', `/api/admin/users?id=${pro.id}`, { cookie: admin })).json?.usage?.balanceUsd > 0);

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) { console.log('\nFailed:\n  - ' + failures.join('\n  - ')); process.exit(1); }
} catch (err) {
  console.error('\nTest run aborted:', err);
  process.exit(1);
}
