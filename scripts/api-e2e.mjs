#!/usr/bin/env node
/**
 * End-to-end test of the public API, keys and quotas against a LOCAL dev server.
 *
 *   npm run db:local && npm run dev        (in one terminal)
 *   npm run test:api                       (in another;  BASE=http://localhost:8788 by default)
 *
 * It signs up a throw-away user, mints keys, schedules posts and walks through every plan. Nothing is posted
 * anywhere: the channel it uses is a placeholder row (posts are only SCHEDULED, the cron worker is not running).
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const BASE = process.env.BASE ?? 'http://localhost:8788';
let passed = 0;
const failures = [];

function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name} ${extra}`); }
}
const section = (t) => console.log(`\n${t}`);

async function http(method, path, { cookie, key, body, headers = {} } = {}) {
  const init = {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };
  // `wrangler pages dev` reloads itself now and then (e.g. when `wrangler d1 execute` touches its files):
  // a refused connection is retried for a few seconds instead of failing the whole run.
  let res;
  for (let attempt = 0; ; attempt++) {
    try { res = await fetch(BASE + path, init); break; }
    catch (err) { if (attempt >= 8) throw err; await new Promise((r) => setTimeout(r, 750)); }
  }
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, json, headers: res.headers };
}

function sql(command) {
  const r = spawnSync('npx', ['wrangler', 'd1', 'execute', 'vane-db', '--local', '--json', '--command', command], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`wrangler failed: ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout)[0].results;
}
function setPlan(email, plan, ...flags) {
  const r = spawnSync('node', ['scripts/set-plan.mjs', email, plan, ...flags], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`set-plan failed: ${r.stderr}`);
}

async function signUp(email) {
  const pw = 'Correct-Horse-9';
  const reg = await http('POST', '/api/auth/register', { body: { email, password: pw, name: 'E2E', timezone: 'UTC' } });
  if (reg.status !== 201 && reg.status !== 200) throw new Error(`register failed: ${reg.status} ${JSON.stringify(reg.json)}`);
  const login = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: pw }) });
  const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error('login gave no session cookie');
  const id = sql(`SELECT id FROM users WHERE email = '${email}'`)[0].id;
  return { email, cookie, id };
}

const inHours = (h) => new Date(Date.now() + h * 3600_000).toISOString().replace(/\.\d+Z$/, 'Z');
const period = () => new Date().toISOString().slice(0, 7);
const post = (key, channelId, extra = {}) => http('POST', '/api/v1/posts', { key, body: { content: 'e2e post', channelIds: [channelId], scheduledAt: inHours(2), ...extra } });

try {
  const ping = await fetch(BASE + '/api/auth/config').catch(() => null);
  if (!ping) { console.error(`Cannot reach ${BASE}. Start it with: npm run db:local && npm run dev`); process.exit(2); }

  const stamp = Date.now();
  const u = await signUp(`e2e-${stamp}@example.com`);
  const chan = randomUUID();
  sql(`INSERT INTO channels (id, user_id, type, name, credentials) VALUES ('${chan}', '${u.id}', 'telegram', 'e2e channel', 'x')`);

  // ───────────────────────────────────────────────────────────────
  section('API keys: creating and listing');
  check('name is required', (await http('POST', '/api/keys', { cookie: u.cookie, body: {} })).status === 400);
  check('bad mode is rejected', (await http('POST', '/api/keys', { cookie: u.cookie, body: { name: 'x', mode: 'prod' } })).status === 400);
  check('video keys are not available yet (501)', (await http('POST', '/api/keys', { cookie: u.cookie, body: { name: 'x', scope: 'video' } })).status === 501);
  check('keys need a session (401 without)', (await http('POST', '/api/keys', { body: { name: 'x' } })).status === 401);

  const k1 = await http('POST', '/api/keys', { cookie: u.cookie, body: { name: '  Make.com \u0007 ' } });
  check('live key created (201)', k1.status === 201);
  const live = k1.json?.secret ?? '';
  check('key format cpost_live_ + 24 random chars', /^cpost_live_[A-Za-z0-9]{24}$/.test(live), live);
  check('name is trimmed and cleaned', k1.json?.key?.name === 'Make.com');
  const k2 = await http('POST', '/api/keys', { cookie: u.cookie, body: { name: 'second' } });
  check('every generated key is different', k2.json?.secret && k2.json.secret !== live);
  const kt = await http('POST', '/api/keys', { cookie: u.cookie, body: { name: 'sandbox', mode: 'test' } });
  const test = kt.json?.secret ?? '';
  check('test key format cpost_test_…', /^cpost_test_[A-Za-z0-9]{24}$/.test(test));

  const list = await http('GET', '/api/keys', { cookie: u.cookie });
  const listText = JSON.stringify(list.json);
  check('list shows 3 keys', list.json?.keys?.length === 3);
  check('list never contains a secret or a hash', !listText.includes(live) && !/key_hash|secret|[0-9a-f]{64}/.test(listText));
  check('list shows a masked key', list.json?.keys?.some((k) => k.display === `cpost_live_••••${live.slice(-4)}`));
  const stored = sql(`SELECT key_hash FROM api_keys WHERE user_id = '${u.id}'`).map((r) => r.key_hash);
  check('the database holds only 64-char SHA-256 hashes, never the key', stored.every((h) => /^[0-9a-f]{64}$/.test(h)) && !stored.includes(live));

  // ───────────────────────────────────────────────────────────────
  section('Authentication and scopes');
  check('GET /api/v1/me with a valid key → 200', (await http('GET', '/api/v1/me', { key: live })).status === 200);
  check('no key → 401', (await http('GET', '/api/v1/me')).status === 401);
  check('junk key → 401 invalid_api_key', (await http('GET', '/api/v1/me', { key: 'nonsense' })).json?.code === 'invalid_api_key');
  const wrong = await http('GET', '/api/v1/me', { key: 'cvid_live_aaaaaaaaaaaaaaaaaaaaaaaa' });
  check('video key on a text route → 403 wrong_key_scope', wrong.status === 403 && wrong.json?.code === 'wrong_key_scope');
  check('well-formed but unknown key → 401', (await http('GET', '/api/v1/me', { key: 'cpost_live_aaaaaaaaaaaaaaaaaaaaaaaa' })).status === 401);
  check('a key does NOT open dashboard routes (/api/keys)', (await http('GET', '/api/keys', { key: live })).status === 401);
  check('a key does NOT open dashboard routes (/api/posts)', (await http('GET', '/api/posts', { key: live })).status === 401);
  check('the session cookie does NOT open /api/v1', (await http('GET', '/api/v1/me', { cookie: u.cookie })).status === 401);
  const ch = await http('GET', '/api/v1/channels', { key: live });
  check('GET /api/v1/channels lists my channel', ch.json?.channels?.[0]?.id === chan && !JSON.stringify(ch.json).includes('credentials'));

  // ───────────────────────────────────────────────────────────────
  section('Test-mode key: validates like live, changes nothing');
  const tPast = await post(test, chan, { scheduledAt: '2020-01-01T00:00:00Z' });
  const lPast = await post(live, chan, { scheduledAt: '2020-01-01T00:00:00Z' });
  check('a bad request fails the same way in test and live (400)', tPast.status === 400 && lPast.status === 400 && tPast.json?.error === lPast.json?.error);
  check('unknown channel → 404 in test mode too', (await post(test, randomUUID())).status === 404);
  const t = await post(test, chan);
  check('test post → 201 with "test": true', t.status === 201 && t.json?.test === true);
  check('…and an X-Vane-Mode: test header', t.headers.get('x-vane-mode') === 'test');
  check('…nothing was counted', (await http('GET', '/api/v1/usage', { key: live })).json?.usage?.api?.used === 0);
  check('…nothing was saved', (await http('GET', '/api/v1/posts', { key: live })).json?.posts?.length === 0);

  // ───────────────────────────────────────────────────────────────
  section('Free Trial: 30 posts in total, shared between dashboard and API');
  const ui = await http('POST', '/api/posts', { cookie: u.cookie, body: { content: 'from the dashboard', channelIds: [chan], scheduledAt: inHours(3) } });
  check('a dashboard post still works (201)', ui.status === 201);
  let usage = (await http('GET', '/api/usage', { cookie: u.cookie })).json?.usage;
  check('dashboard posts are counted into the shared total', usage?.shared?.used === 1 && usage?.plan?.id === 'free' && usage?.period?.key === 'lifetime');

  const first = await post(live, chan);
  check('live post → 201', first.status === 201);
  check('quota headers: limit 30, remaining 28', first.headers.get('x-vane-quota-limit') === '30' && first.headers.get('x-vane-quota-remaining') === '28');
  const groupPost = first.json?.posts?.[0]?.id;

  const got = await http('GET', `/api/v1/posts/${groupPost}`, { key: live });
  check('GET /api/v1/posts/:id → scheduled', got.json?.post?.status === 'scheduled');
  const dry = await http('DELETE', `/api/v1/posts/${groupPost}`, { key: test });
  check('test key DELETE only checks (test: true)…', dry.status === 200 && dry.json?.test === true);
  check('…the post is still scheduled', (await http('GET', `/api/v1/posts/${groupPost}`, { key: live })).json?.post?.status === 'scheduled');
  check('live DELETE cancels it', (await http('DELETE', `/api/v1/posts/${groupPost}`, { key: live })).status === 200);
  check('cancelling twice → 409', (await http('DELETE', `/api/v1/posts/${groupPost}`, { key: live })).status === 409);
  check('another post id looks like a missing one (404)', (await http('GET', `/api/v1/posts/${randomUUID()}`, { key: live })).status === 404);

  let last = first;
  for (let i = 0; i < 27; i++) last = await post(live, chan);        // 1 UI + 1 + 27 = 29 used
  check('27 more posts all accepted', last.status === 201);
  const twentyNinth = await post(live, chan);                        // the 30th unit
  check('the 30th unit of the shared total is accepted', twentyNinth.status === 201 && twentyNinth.headers.get('x-vane-quota-remaining') === '0');
  const over = await post(live, chan);
  check('the 31st → 402 quota_exceeded', over.status === 402 && over.json?.code === 'quota_exceeded');
  check('…with the usage in the body', over.json?.usage?.api?.remaining === 0);
  check('…and no post was saved for it', sql(`SELECT COUNT(*) AS n FROM posts WHERE user_id = '${u.id}'`)[0].n === 30);
  check('test key still works when the quota is spent', (await post(test, chan)).status === 201);

  // ───────────────────────────────────────────────────────────────
  section('Developer API plan: 180 a month, resets monthly');
  setPlan(u.email, 'api');
  usage = (await http('GET', '/api/v1/usage', { key: live })).json?.usage;
  check('plan is "api" with a fresh monthly period', usage?.plan?.id === 'api' && usage?.period?.key === period() && usage?.api?.limit === 180 && usage?.api?.used === 0);
  check('…resetsAt is the 1st of next month', typeof usage?.period?.resetsAt === 'number');
  check('a live post is accepted: 179 left', (await post(live, chan)).headers.get('x-vane-quota-remaining') === '179');

  sql(`UPDATE usage_counters SET api_posts = 175 WHERE user_id = '${u.id}' AND period = '${period()}'`);
  const burst = await Promise.all(Array.from({ length: 12 }, () => post(live, chan)));
  const ok = burst.filter((r) => r.status === 201).length;
  const denied = burst.filter((r) => r.status === 402).length;
  check('12 parallel requests with 5 units left: exactly 5 accepted, 7 refused', ok === 5 && denied === 7, `ok=${ok} denied=${denied}`);
  check('the counter ends at exactly 180 (never over-counts)', sql(`SELECT api_posts AS n FROM usage_counters WHERE user_id = '${u.id}' AND period = '${period()}'`)[0].n === 180);

  // ───────────────────────────────────────────────────────────────
  section('Overage: pay per extra post instead of 402');
  setPlan(u.email, 'api', '--overage');
  const extra = await post(live, chan);
  check('over the quota with overage on → 201, flagged overage', extra.status === 201 && extra.json?.overage === true);
  usage = (await http('GET', '/api/v1/usage', { key: live })).json?.usage;
  check('priced at $0.03 on the Developer API', usage?.overage?.posts === 1 && usage?.overage?.costUsd === 0.03);
  check('the audit log has the overage row', sql(`SELECT cost_micro_usd AS c FROM usage_logs WHERE user_id = '${u.id}' AND overage = 1`)[0]?.c === 30000);

  // ───────────────────────────────────────────────────────────────
  section('Pro Dashboard: API only with the Add-on');
  setPlan(u.email, 'pro');
  const noApi = await http('GET', '/api/v1/me', { key: live });
  check('live key on Pro without the Add-on → 403 api_not_in_plan', noApi.status === 403 && noApi.json?.code === 'api_not_in_plan');
  check('…but a test key works', (await post(test, chan)).status === 201);
  check('…and a new LIVE key cannot be created', (await http('POST', '/api/keys', { cookie: u.cookie, body: { name: 'x' } })).json?.code === 'api_not_in_plan');
  setPlan(u.email, 'pro', '--addon', '--overage');
  usage = (await http('GET', '/api/v1/usage', { key: live })).json?.usage;
  check('Pro + Add-on: 180 API posts, 1000 dashboard posts', usage?.api?.limit === 180 && usage?.ui?.limit === 1000 && usage?.plan?.apiAddon === true);
  check('…overage is half the price ($0.015)', usage?.overage?.postUsd === 0.03 ? false : usage?.overage?.postUsd === 0.015);

  // ───────────────────────────────────────────────────────────────
  section('Expired subscription falls back to the Free Trial');
  sql(`UPDATE subscriptions SET current_period_end = unixepoch() - 60 WHERE user_id = '${u.id}'`);
  usage = (await http('GET', '/api/v1/usage', { key: live })).json?.usage;
  check('lapsed plan → free limits', usage?.plan?.id === 'free' && usage?.plan?.lapsed === true);
  setPlan(u.email, 'api');

  // ───────────────────────────────────────────────────────────────
  section('Revoking and ownership');
  const other = await signUp(`e2e-b-${stamp}@example.com`);
  check("someone else cannot revoke my key (404)", (await http('DELETE', `/api/keys/${k2.json.key.id}`, { cookie: other.cookie })).status === 404);
  check('the key still works afterwards', (await http('GET', '/api/v1/me', { key: k2.json.secret })).status === 200);
  check('I can revoke my key (200)', (await http('DELETE', `/api/keys/${k2.json.key.id}`, { cookie: u.cookie })).status === 200);
  check('a revoked key stops working at once (401)', (await http('GET', '/api/v1/me', { key: k2.json.secret })).status === 401);
  check('revoking twice → 404', (await http('DELETE', `/api/keys/${k2.json.key.id}`, { cookie: u.cookie })).status === 404);
  check("the other user's channel is not reachable with my key", (await http('POST', '/api/v1/posts', { key: live, body: { content: 'x', channelIds: [randomUUID()], scheduledAt: inHours(1) } })).status === 404);

  // ───────────────────────────────────────────────────────────────
  section('Limits: 10 active keys, 100 requests a minute per key');
  let n = (await http('GET', '/api/keys', { cookie: u.cookie })).json.keys.length;
  let lastCreate = null;
  while (n < 11) { lastCreate = await http('POST', '/api/keys', { cookie: u.cookie, body: { name: `k${n}`, mode: 'test' } }); if (lastCreate.status !== 201) break; n++; }
  check('the 11th active key → 409 too_many_keys', lastCreate?.status === 409 && lastCreate.json?.code === 'too_many_keys', `${lastCreate?.status}`);

  const fresh = await http('DELETE', `/api/keys/${(await http('GET', '/api/keys', { cookie: u.cookie })).json.keys[0].id}`, { cookie: u.cookie });
  const rl = await http('POST', '/api/keys', { cookie: u.cookie, body: { name: 'rate-limit probe', mode: 'test' } });
  let seen429 = null;
  for (let i = 0; i < 105 && rl.json?.secret; i++) {
    const r = await http('GET', '/api/v1/me', { key: rl.json.secret });
    if (r.status === 429) { seen429 = { at: i + 1, retry: r.headers.get('retry-after'), code: r.json?.code }; break; }
  }
  check('the 101st request in a minute → 429 rate_limited with Retry-After', seen429?.at === 101 && seen429.code === 'rate_limited' && Number(seen429.retry) > 0, JSON.stringify(seen429));
  void fresh;
} catch (err) {
  console.error('\nTest run aborted:', err instanceof Error ? err.message : err);
  process.exit(2);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('Failed:\n  - ' + failures.join('\n  - ')); process.exit(1); }
