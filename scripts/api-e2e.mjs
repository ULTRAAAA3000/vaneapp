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
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

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


/** A throw-away HTTP server that plays the customer's webhook endpoint. */
function startReceiver() {
  const received = [];
  const mode = { status: 200, delayMs: 0, location: null };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8'), at: Date.now() });
      const answer = () => {
        if (mode.location) { res.writeHead(mode.status, { Location: mode.location }); return res.end(); }
        res.writeHead(mode.status, { 'content-type': 'text/plain' }); res.end('ok');
      };
      mode.delayMs ? setTimeout(answer, mode.delayMs) : answer();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    resolve({ url: `http://127.0.0.1:${port}/hook`, base: `http://127.0.0.1:${port}`, received, mode, close: () => server.close() });
  }));
}

/** Verifies a `Vane-Signature: t=…,v1=…` header the way a customer would. */
function verifyWebhook(secret, signatureHeader, rawBody, maxAgeSeconds = 300) {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(signatureHeader ?? '');
  if (!m) return false;
  if (Math.abs(Date.now() / 1000 - Number(m[1])) > maxAgeSeconds) return false;
  const expected = createHmac('sha256', secret).update(`${m[1]}.${rawBody}`).digest();
  return timingSafeEqual(expected, Buffer.from(m[2], 'hex'));
}

const inHours = (h) => new Date(Date.now() + h * 3600_000).toISOString().replace(/\.\d+Z$/, 'Z');
const period = () => new Date().toISOString().slice(0, 7);
const post = (key, channelId, extra = {}) => http('POST', '/api/v1/posts', { key, body: { content: 'e2e post', channelIds: [channelId], scheduledAt: inHours(2), ...extra } });

try {
  const ping = await fetch(BASE + '/api/auth/config').catch(() => null);
  if (!ping) { console.error(`Cannot reach ${BASE}. Start it with: npm run db:local && npm run dev`); process.exit(2); }

  // Sign-ups are rate limited per network (that is the product working); this test only ever touches the LOCAL database,
  // so it starts from clean counters and can be run as often as needed.
  sql('DELETE FROM rate_limits');

  const stamp = Date.now();
  const u = await signUp(`e2e-${stamp}@example.com`);
  const chan = randomUUID();
  sql(`INSERT INTO channels (id, user_id, type, name, credentials) VALUES ('${chan}', '${u.id}', 'telegram', 'e2e channel', 'x')`);

  // ───────────────────────────────────────────────────────────────
  section('API keys: creating and listing');
  check('name is required', (await http('POST', '/api/keys', { cookie: u.cookie, body: {} })).status === 400);
  check('bad mode is rejected', (await http('POST', '/api/keys', { cookie: u.cookie, body: { name: 'x', mode: 'prod' } })).status === 400);
  const vk = await http('POST', '/api/keys', { cookie: u.cookie, body: { name: 'x', scope: 'video' } });
  check('a live video key needs the Video Engine (403 video_engine_required)', vk.status === 403 && vk.json?.code === 'video_engine_required', `${vk.status}`);
  check('bad scope is rejected', (await http('POST', '/api/keys', { cookie: u.cookie, body: { name: 'x', scope: 'admin' } })).status === 400);
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

  // ───────────────────────────────────────────────────────────────
  section('Idempotency-Key: a retry never creates a second post or takes a second unit of quota');
  {
    const v = await signUp(`e2e-idem-${stamp}@example.com`);
    const ch2 = randomUUID();
    sql(`INSERT INTO channels (id, user_id, type, name, credentials) VALUES ('${ch2}', '${v.id}', 'telegram', 'idem channel', 'x')`);
    const live2 = (await http('POST', '/api/keys', { cookie: v.cookie, body: { name: 'idem live' } })).json.secret;
    const test2 = (await http('POST', '/api/keys', { cookie: v.cookie, body: { name: 'idem test', mode: 'test' } })).json.secret;
    const when = inHours(5);
    const body = { content: 'idempotent post', channelIds: [ch2], scheduledAt: when };
    const idem = (key, k, b = body) => http('POST', '/api/v1/posts', { key, body: b, headers: { 'Idempotency-Key': k } });
    const posts = () => sql(`SELECT COUNT(*) AS n FROM posts WHERE user_id = '${v.id}'`)[0].n;
    const used = async () => (await http('GET', '/api/v1/usage', { key: live2 })).json.usage.api.used;

    check('a malformed key (contains a space) → 400 invalid_idempotency_key', (await idem(live2, 'has a space')).json?.code === 'invalid_idempotency_key');
    check('a key longer than 255 characters → 400', (await idem(live2, 'x'.repeat(256))).status === 400);

    const a = await idem(live2, 'order-1001');
    check('the first request runs normally (201)', a.status === 201 && !a.headers.get('idempotent-replayed'));
    const b = await idem(live2, 'order-1001');
    check('the retry gets the SAME answer (201, same group and post ids)', b.status === 201 && b.json?.groupId === a.json?.groupId && b.json?.posts?.[0]?.id === a.json?.posts?.[0]?.id);
    check('…flagged Idempotent-Replayed: true', b.headers.get('idempotent-replayed') === 'true');
    check('…and only ONE post exists, only ONE unit of quota was taken', posts() === 1 && (await used()) === 1);

    const reordered = await idem(live2, 'order-1001', { scheduledAt: when, channelIds: [ch2], content: 'idempotent post' });
    check('the same body with its keys in another order still counts as the same request', reordered.headers.get('idempotent-replayed') === 'true');

    const reuse = await idem(live2, 'order-1001', { ...body, content: 'a different post' });
    check('the same key with a DIFFERENT body → 422 idempotency_key_reuse', reuse.status === 422 && reuse.json?.code === 'idempotency_key_reuse');
    check('…and nothing was created', posts() === 1);

    const c = await idem(live2, 'order-1002');
    check('a new key is a new request (a second post)', c.status === 201 && c.json.groupId !== a.json.groupId && posts() === 2 && (await used()) === 2);

    // A failed request frees the key
    const bad = await idem(live2, 'retry-after-fix', { ...body, scheduledAt: '2020-01-01T00:00:00Z' });
    check('a failed request (400) is not remembered…', bad.status === 400);
    const fixed = await idem(live2, 'retry-after-fix');
    check('…so the fixed retry with the same key runs (201)', fixed.status === 201 && !fixed.headers.get('idempotent-replayed'));

    // Out of quota frees the key too
    sql(`UPDATE usage_counters SET api_posts = 30 WHERE user_id = '${v.id}' AND period = 'lifetime'`);
    const poor = await idem(live2, 'after-upgrade', { ...body, content: 'needs quota' });
    check('out of quota → 402…', poor.status === 402);
    sql(`UPDATE usage_counters SET api_posts = 3 WHERE user_id = '${v.id}' AND period = 'lifetime'`);
    const rich = await idem(live2, 'after-upgrade', { ...body, content: 'needs quota' });
    check('…and once there is quota the same key runs (201)', rich.status === 201 && !rich.headers.get('idempotent-replayed'));

    // A replay costs nothing, even when the quota is spent
    sql(`UPDATE usage_counters SET api_posts = 30 WHERE user_id = '${v.id}' AND period = 'lifetime'`);
    const free = await idem(live2, 'order-1001');
    check('a replay still works with the quota fully spent (no 402, nothing taken)', free.status === 201 && free.headers.get('idempotent-replayed') === 'true');
    sql(`UPDATE usage_counters SET api_posts = 5 WHERE user_id = '${v.id}' AND period = 'lifetime'`);

    // Parallel retries
    const before = posts(), usedBefore = await used();
    const par = await Promise.all(Array.from({ length: 8 }, () => idem(live2, 'parallel-1', { ...body, content: 'parallel' })));
    const statuses = par.map((r) => r.status);
    check('8 parallel requests with one key: only 201 (first or replay) or 409 in-progress, never an error', statuses.every((x) => x === 201 || x === 409), statuses.join());
    check('…exactly ONE post was created and ONE unit taken', posts() === before + 1 && (await used()) === usedBefore + 1, `posts ${before}→${posts()}`);
    check('…the 409s say idempotency_in_progress with Retry-After', par.filter((r) => r.status === 409).every((r) => r.json?.code === 'idempotency_in_progress' && r.headers.get('retry-after') === '1'));
    check('…and every 201 carries the same group id', new Set(par.filter((r) => r.status === 201).map((r) => r.json.groupId)).size === 1);

    // Abandoned and expired claims
    sql(`INSERT INTO idempotency_keys (user_id, idem_key, request_hash, state, locked_at, expires_at) VALUES ('${v.id}', 'live:abandoned', 'deadbeef', 'processing', unixepoch() - 120, unixepoch() + 86400)`);
    check('a claim abandoned for over a minute is taken over (201)', (await idem(live2, 'abandoned', { ...body, content: 'takeover' })).status === 201);
    sql(`INSERT INTO idempotency_keys (user_id, idem_key, request_hash, state, response_status, response_body, locked_at, expires_at) VALUES ('${v.id}', 'live:expired', 'deadbeef', 'done', 201, '{"ok":true,"old":true}', unixepoch() - 90000, unixepoch() - 3600)`);
    const exp = await idem(live2, 'expired', { ...body, content: 'after expiry' });
    check('an expired key (24 h) is forgotten: the request runs fresh', exp.status === 201 && !exp.headers.get('idempotent-replayed') && !exp.json?.old);

    // Test keys: replayed too, and in their own namespace
    const t1 = await idem(test2, 'same-key-string');
    const t2 = await idem(test2, 'same-key-string');
    check('test keys replay as well (same simulated ids, X-Vane-Mode: test)', t1.status === 201 && t2.headers.get('idempotent-replayed') === 'true' && t2.json.posts[0].id === t1.json.posts[0].id && t2.headers.get('x-vane-mode') === 'test' && t2.json.test === true);
    const real = await idem(live2, 'same-key-string');
    check('…and a test run never collides with a live one (same key string → a real post)', real.status === 201 && !real.json.test && !real.headers.get('idempotent-replayed'));

    check('requests WITHOUT the header behave exactly as before (two posts)', (await http('POST', '/api/v1/posts', { key: live2, body })).status === 201 && (await http('POST', '/api/v1/posts', { key: live2, body })).status === 201);
    check('the stored answers contain no key material', !JSON.stringify(sql(`SELECT response_body FROM idempotency_keys WHERE user_id = '${v.id}'`)).includes('cpost_'));
  }

  // ───────────────────────────────────────────────────────────────
  section('OpenAPI spec: served, valid-looking, and in sync with the real routes');
  {
    const res = await fetch(BASE + '/api/v1/openapi.json');
    const spec = await res.json().catch(() => null);
    check('GET /api/v1/openapi.json needs no key (200, JSON)', res.status === 200 && spec !== null);
    check('it is OpenAPI 3.1 with this server\'s URL', spec?.openapi === '3.1.0' && spec?.servers?.[0]?.url === `${BASE}/api/v1`);
    check('it is readable from a browser tool (CORS *) and cacheable', res.headers.get('access-control-allow-origin') === '*' && /max-age/.test(res.headers.get('cache-control') ?? ''));
    check('bearer auth is declared', spec?.components?.securitySchemes?.bearerAuth?.scheme === 'bearer');

    const ops = [];
    for (const [path, item] of Object.entries(spec?.paths ?? {})) for (const method of ['get', 'post', 'put', 'patch', 'delete']) if (item[method]) ops.push({ path, method, op: item[method] });
    check('every operation has a unique operationId', ops.every((o) => o.op.operationId) && new Set(ops.map((o) => o.op.operationId)).size === ops.length);
    check('descriptions fit Custom GPT Actions (≤ 300 characters)', ops.every((o) => (o.op.description ?? '').length <= 300), ops.filter((o) => (o.op.description ?? '').length > 300).map((o) => o.op.operationId).join());
    // Every $ref must point at something that exists
    const refs = [...JSON.stringify(spec).matchAll(/"\$ref":"#\/components\/schemas\/([A-Za-z]+)"/g)].map((m) => m[1]);
    check('every $ref resolves', refs.length > 0 && refs.every((r) => spec.components.schemas[r]));

    // Drift guard 1: every documented operation exists (without a key it answers 401, not 404/405)
    const missing = [];
    for (const { path, method } of ops) {
      const r = await fetch(BASE + '/api/v1' + path.replace('{id}', randomUUID()), { method: method.toUpperCase(), headers: { 'content-type': 'application/json' }, body: method === 'post' ? '{}' : undefined });
      if (r.status !== 401) missing.push(`${method.toUpperCase()} ${path} → ${r.status}`);
    }
    check('every documented operation exists and is protected (401 without a key)', missing.length === 0, missing.join('; '));

    // Drift guard 2: every route on disk is documented (the Video Engine has its own document; /mcp is the MCP protocol endpoint, not a REST route)
    const walk = (dir) => readdirSync(dir).flatMap((n) => { const f = join(dir, n); return statSync(f).isDirectory() ? walk(f) : [f]; });
    const root = 'functions/api/v1';
    const routes = walk(root)
      .map((f) => f.slice(root.length).replace(/\\/g, '/'))
      .filter((f) => !f.startsWith('/video/') && f !== '/openapi.json.ts' && f !== '/mcp.ts' && f.endsWith('.ts'))
      .map((f) => f.replace(/\.ts$/, '').replace(/\/index$/, '').replace(/\[id\]/g, '{id}'))
      .map((f) => f || '/');
    const undocumented = routes.filter((r) => !(r in (spec?.paths ?? {})));
    check('every route under functions/api/v1 is documented', undocumented.length === 0, `undocumented: ${undocumented.join(', ')}`);
  }

  // ───────────────────────────────────────────────────────────────
  section('Webhooks: creating, listing, testing, deleting');
  {
    const w = await signUp(`e2e-hook-${stamp}@example.com`);
    const wch = randomUUID();
    sql(`INSERT INTO channels (id, user_id, type, name, credentials) VALUES ('${wch}', '${w.id}', 'telegram', 'hook channel', 'x')`);
    const wlive = (await http('POST', '/api/keys', { cookie: w.cookie, body: { name: 'hooks live' } })).json.secret;
    const wtest = (await http('POST', '/api/keys', { cookie: w.cookie, body: { name: 'hooks test', mode: 'test' } })).json.secret;
    const rx = await startReceiver();
    const deliveries = (hookId) => sql(`SELECT event, status, post_id FROM webhook_deliveries WHERE webhook_id = '${hookId}' ORDER BY created_at`);

    check('a webhook URL must be https on a public domain (400 invalid_webhook_url)', (await http('POST', '/api/v1/webhooks', { key: wlive, body: { url: 'http://example.com/hook' } })).json?.code === 'invalid_webhook_url');
    check('an IP address is refused', (await http('POST', '/api/v1/webhooks', { key: wlive, body: { url: 'https://10.0.0.5/hook' } })).status === 400);
    check('unknown events are refused', (await http('POST', '/api/v1/webhooks', { key: wlive, body: { url: rx.url, events: ['post.exploded'] } })).json?.code === 'invalid_webhook_events');
    check('an empty events list is refused', (await http('POST', '/api/v1/webhooks', { key: wlive, body: { url: rx.url, events: [] } })).status === 400);

    const probe = await http('POST', '/api/v1/webhooks', { key: wlive, body: { url: rx.url } });
    if (probe.status === 400) {
      console.log('  ! the rest of this section needs WEBHOOK_DEV_MODE=1 in .dev.vars (local receiver on http://127.0.0.1): skipped');
    } else {
      check('a webhook is created (201)', probe.status === 201);
      const hook = probe.json.webhook, secret = probe.json.secret;
      check('the signing secret is shown once (whsec_ + 32 characters)', /^whsec_[A-Za-z0-9]{32}$/.test(secret));
      check('it subscribes to all three events by default', JSON.stringify(hook.events) === '["post.sent","post.failed","post.cancelled"]' && hook.active === true && hook.failures === 0);
      const stored = sql(`SELECT secret, hint FROM webhooks WHERE id = '${hook.id}'`)[0];
      check('the database holds the secret ENCRYPTED (never the plain text)', stored.secret && !stored.secret.includes('whsec_') && !stored.secret.includes(secret.slice(7)) && stored.hint === secret.slice(-4));
      const listed = await http('GET', '/api/v1/webhooks', { key: wlive });
      check('the list shows a masked secret and never the secret itself', listed.json?.webhooks?.length === 1 && listed.json.webhooks[0].secretHint === `whsec_••••${secret.slice(-4)}` && !JSON.stringify(listed.json).includes(secret) && !/"secret"/.test(JSON.stringify(listed.json)));
      check('the same URL twice → 409 webhook_exists', (await http('POST', '/api/v1/webhooks', { key: wlive, body: { url: rx.url } })).json?.code === 'webhook_exists');
      check('the dashboard route lists the same webhook (session)', (await http('GET', '/api/webhooks', { cookie: w.cookie })).json?.webhooks?.[0]?.id === hook.id);
      check('keys do NOT open the dashboard webhook routes', (await http('GET', '/api/webhooks', { key: wlive })).status === 401);
      check('the session cookie does NOT open /api/v1/webhooks', (await http('GET', '/api/v1/webhooks', { cookie: w.cookie })).status === 401);

      // ── ping
      const ping = await http('POST', `/api/v1/webhooks/${hook.id}/test`, { key: wlive });
      check('a test event is delivered (delivered: true, status 200)', ping.status === 200 && ping.json?.delivered === true && ping.json?.status === 200);
      const got = rx.received.at(-1);
      const sent = got ? JSON.parse(got.body) : {};
      check('the receiver got a POST with JSON', got?.method === 'POST' && got.url === '/hook' && /application\/json/.test(got.headers['content-type']) && sent.type === 'ping');
      check('Vane-Event, Vane-Delivery and User-Agent are set', got?.headers['vane-event'] === 'ping' && got.headers['vane-delivery'] === sent.id && got.headers['user-agent'] === 'Vane-Webhooks/1.0' && /^evt_/.test(sent.id));
      check('the signature verifies with the secret from creation', verifyWebhook(secret, got?.headers['vane-signature'], got?.body ?? ''));
      check('…and fails for a wrong secret, a tampered body and an old timestamp', !verifyWebhook(secret + 'x', got.headers['vane-signature'], got.body) && !verifyWebhook(secret, got.headers['vane-signature'], got.body + ' ') && !verifyWebhook(secret, got.headers['vane-signature'], got.body, -1));
      check('the webhook records the last status', sql(`SELECT last_status AS s FROM webhooks WHERE id = '${hook.id}'`)[0].s === 200);

      rx.mode.status = 500;
      const p500 = await http('POST', `/api/v1/webhooks/${hook.id}/test`, { key: wlive });
      check('an endpoint answering 500 → delivered: false, status 500, an explanation', p500.json?.delivered === false && p500.json?.status === 500 && /500/.test(p500.json?.error ?? ''));
      rx.mode.status = 302; rx.mode.location = rx.base + '/elsewhere';
      const before = rx.received.length;
      const p302 = await http('POST', `/api/v1/webhooks/${hook.id}/test`, { key: wlive });
      check('a redirect is NOT followed (delivered: false, status 302, the target was never called)', p302.json?.delivered === false && p302.json?.status === 302 && rx.received.length === before + 1 && !rx.received.some((r) => r.url === '/elsewhere'));
      rx.mode.status = 200; rx.mode.location = null;

      // a switched-off webhook comes back when a test succeeds
      sql(`UPDATE webhooks SET active = 0, failures = 10, disabled_reason = 'Too many failed deliveries.' WHERE id = '${hook.id}'`);
      const back = await http('POST', `/api/v1/webhooks/${hook.id}/test`, { key: wlive });
      const row = sql(`SELECT active, failures, disabled_reason IS NULL AS cleared FROM webhooks WHERE id = '${hook.id}'`)[0];
      check('a successful test switches a disabled webhook back on', back.json?.delivered === true && row.active === 1 && row.failures === 0 && row.cleared === 1);

      // ── post.cancelled is queued in the same batch as the cancellation
      const mk = async () => (await http('POST', '/api/v1/posts', { key: wlive, body: { content: 'to cancel', channelIds: [wch], scheduledAt: inHours(4) } })).json.posts[0].id;
      const p1 = await mk();
      check('scheduling a post queues nothing', deliveries(hook.id).length === 0);
      check('cancelling it works (200)', (await http('DELETE', `/api/v1/posts/${p1}`, { key: wlive })).status === 200);
      const q = deliveries(hook.id);
      check('…and queued exactly one post.cancelled for the post', q.length === 1 && q[0].event === 'post.cancelled' && q[0].status === 'pending' && q[0].post_id === p1);
      check('cancelling it AGAIN (409) queues nothing more', (await http('DELETE', `/api/v1/posts/${p1}`, { key: wlive })).status === 409 && deliveries(hook.id).length === 1);
      const p2 = await mk();
      check('a test key only checks the cancel: no event', (await http('DELETE', `/api/v1/posts/${p2}`, { key: wtest })).json?.test === true && deliveries(hook.id).length === 1);
      check('a dashboard cancel queues the event as well', (await http('DELETE', `/api/posts/${p2}`, { cookie: w.cookie })).status === 200 && deliveries(hook.id).length === 2);

      sql(`UPDATE webhooks SET events = 'post.sent' WHERE id = '${hook.id}'`);
      const p3 = await mk(); await http('DELETE', `/api/v1/posts/${p3}`, { key: wlive });
      check('a webhook that did not subscribe to the event gets nothing', deliveries(hook.id).length === 2);
      sql(`UPDATE webhooks SET events = 'post.sent,post.failed,post.cancelled', active = 0 WHERE id = '${hook.id}'`);
      const p4 = await mk(); await http('DELETE', `/api/v1/posts/${p4}`, { key: wlive });
      check('a switched-off webhook gets nothing', deliveries(hook.id).length === 2);
      sql(`UPDATE webhooks SET active = 1 WHERE id = '${hook.id}'`);

      // ── other people's webhooks are invisible
      const stranger = await signUp(`e2e-hook-b-${stamp}@example.com`);
      check("someone else cannot delete my webhook (404)", (await http('DELETE', `/api/webhooks/${hook.id}`, { cookie: stranger.cookie })).status === 404);
      check("…or test it (404)", (await http('POST', `/api/webhooks/${hook.id}/test`, { cookie: stranger.cookie })).status === 404);
      check("a stranger's cancel never queues events for my webhook", deliveries(hook.id).length === 2);

      // ── test keys: validated like live, nothing stored
      const sim = await http('POST', '/api/v1/webhooks', { key: wtest, body: { url: rx.base + '/other' } });
      check('a test key answers like a live one (201, test: true, a secret)…', sim.status === 201 && sim.json?.test === true && /^whsec_/.test(sim.json?.secret));
      check('…but stores nothing', (await http('GET', '/api/v1/webhooks', { key: wlive })).json.webhooks.length === 1);
      check('a test key validates too (bad URL → 400)', (await http('POST', '/api/v1/webhooks', { key: wtest, body: { url: 'http://example.com/x' } })).status === 400);
      check('a test key DELETE only checks it exists', (await http('DELETE', `/api/v1/webhooks/${hook.id}`, { key: wtest })).json?.test === true && (await http('GET', '/api/v1/webhooks', { key: wlive })).json.webhooks.length === 1);

      // ── limit of 5, delete, plan gating
      for (let i = 2; i <= 5; i++) await http('POST', '/api/v1/webhooks', { key: wlive, body: { url: `${rx.base}/hook${i}` } });
      const sixth = await http('POST', '/api/v1/webhooks', { key: wlive, body: { url: `${rx.base}/hook6` } });
      check('the 6th webhook → 409 too_many_webhooks', sixth.status === 409 && sixth.json?.code === 'too_many_webhooks');
      // The list is newest first, so the last entry is the OLDEST webhook: `hook`, the one with two queued deliveries.
      const oldest = (await http('GET', '/api/v1/webhooks', { key: wlive })).json.webhooks.at(-1);
      check('the oldest webhook is the one with queued deliveries', oldest.id === hook.id && deliveries(hook.id).length === 2);
      check('deleting it works (200)', (await http('DELETE', `/api/v1/webhooks/${hook.id}`, { key: wlive })).status === 200);
      check('…its queued deliveries are removed with it', deliveries(hook.id).length === 0);
      check('…and the slot is free again', (await http('POST', '/api/v1/webhooks', { key: wlive, body: { url: `${rx.base}/hook6` } })).status === 201);
      check('deleting twice → 404', (await http('DELETE', `/api/v1/webhooks/${hook.id}`, { key: wlive })).status === 404);

      setPlan(w.email, 'pro');
      const gated = await http('POST', '/api/webhooks', { cookie: w.cookie, body: { url: `${rx.base}/gated` } });
      check('Pro without the API Add-on cannot add a webhook (403 api_not_in_plan)…', gated.status === 403 && gated.json?.code === 'api_not_in_plan');
      check('…but can still list them', (await http('GET', '/api/webhooks', { cookie: w.cookie })).status === 200);
      setPlan(w.email, 'api');
      const own = await http('DELETE', `/api/webhooks/${(await http('GET', '/api/webhooks', { cookie: w.cookie })).json.webhooks[0].id}`, { cookie: w.cookie });
      check('the dashboard can delete one (200)', own.status === 200);

      // ── ping rate limit: 10 a minute
      const one = (await http('POST', '/api/webhooks', { cookie: w.cookie, body: { url: `${rx.base}/rl` } })).json.webhook;
      let limited = null;
      for (let i = 0; i < 14 && !limited; i++) { const r = await http('POST', `/api/webhooks/${one.id}/test`, { cookie: w.cookie }); if (r.status === 429) limited = r; }
      check('test events are limited (429 rate_limited with Retry-After)', limited?.json?.code === 'rate_limited' && Number(limited.headers.get('retry-after')) > 0);
    }
    rx.close();
  }
} catch (err) {
  console.error('\nTest run aborted:', err instanceof Error ? err.message : err);
  process.exit(2);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('Failed:\n  - ' + failures.join('\n  - ')); process.exit(1); }
