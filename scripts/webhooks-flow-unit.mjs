#!/usr/bin/env node
/**
 * The whole webhook flow on the REAL handlers and the REAL schema.sql (in-memory SQLite), with a fake receiver instead of the network:
 * subscribing (/api/v1/webhooks), the outbox, signing, retries, 410, redirects, timeouts, Retry-After, parallel delivery and
 * the clean-up. It also runs the Node.js sample from the developers page against real deliveries, so the docs cannot drift.
 *   npm run test:unit
 */
import { build } from 'esbuild';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHmac } from 'node:crypto';

const dir = mkdtempSync(join(tmpdir(), 'vane-unit-'));
const load = async (entry, name) => {
  await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: join(dir, `${name}.mjs`), logLevel: 'silent' });
  return import(pathToFileURL(join(dir, `${name}.mjs`)).href);
};
const wh = await load('functions/api/lib/webhooks.ts', 'wh');
const subs = await load('functions/api/v1/webhooks/index.ts', 'subs');
const subId = await load('functions/api/v1/webhooks/[id].ts', 'subid');
const keys = await load('functions/api/lib/apikeys.ts', 'keys');

// the Node.js sample from the developers page, exactly as a customer would copy it
const page = readFileSync('site/developers.html', 'utf8');
const sample = /Verify a webhook[\s\S]*?<pre[^>]*>([\s\S]*?)<\/pre>/.exec(page)?.[1]
  ?.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
if (sample) writeFileSync(join(dir, 'docs-verify.mjs'), sample);
const docsVerify = sample ? (await import(pathToFileURL(join(dir, 'docs-verify.mjs')).href)).verify : null;

let passed = 0;
const failed = [];
const check = (name, cond, extra = '') => { if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed.push(name); console.log(`  ✗ ${name} ${extra}`); } };

function fresh() {
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
  const env = { ENCRYPTION_KEY: 'k'.repeat(40), DB: { prepare: mk, async batch(stmts) {
    db.exec('BEGIN');
    try { const out = []; for (const s of stmts) out.push(await s.run()); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; }
  } } };
  db.exec(`INSERT INTO users (id, email) VALUES ('u1', 'a@example.com'), ('u2', 'b@example.com')`);
  db.exec(`INSERT INTO channels (id, user_id, type, name, credentials) VALUES ('c1', 'u1', 'telegram', 'VaneNews', 'SECRET-CREDENTIALS-BLOB')`);
  return { db, env };
}
async function addKey(db, id, user, mode) {
  const k = await keys.generateApiKey('post', mode);
  db.prepare(`INSERT INTO api_keys (id, user_id, name, scope, mode, key_hash, hint) VALUES (?, ?, ?, 'post', ?, ?, ?)`).run(id, user, id, mode, k.hash, k.hint);
  return k.secret;
}
const NOW = 1_800_000_000;
let ipN = 1;
async function api(env, mod, method, url, key, body, params = {}) {
  const req = new Request(`https://vaneapp.dev${url}`, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'cf-connecting-ip': `203.0.113.${ipN++ % 250}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  const fn = mod[`onRequest${method[0]}${method.slice(1).toLowerCase()}`] ?? mod.onRequest;
  const res = await fn({ request: req, env, params, waitUntil() {} });
  let data = null; try { data = await res.clone().json(); } catch { /* not JSON */ }
  return { status: res.status, data };
}
const addPost = (db, id, status = 'sent') => db.prepare(`INSERT INTO posts (id, group_id, user_id, channel_id, content, scheduled_at, status, sent_at, external_id) VALUES (?, ?, 'u1', 'c1', ?, ?, ?, ?, '42')`)
  .run(id, `g-${id}`, 'Hello <world> "quotes" é中', NOW - 10, status, NOW - 5);

// the fake receiver
const sent = [];
let behaviour = () => ({ status: 200 });
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const b = behaviour(String(url), init);
  sent.push({ url: String(url), init, t: Date.now() });
  if (b.throw) throw b.throw;
  if (b.delay) await new Promise((r) => setTimeout(r, b.delay));
  return new Response(null, { status: b.status ?? 200, headers: b.headers });
};
const sigOk = (d, secret) => {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(d.init.headers['Vane-Signature'] ?? '');
  return !!m && createHmac('sha256', secret).update(`${m[1]}.${d.init.body}`).digest('hex') === m[2];
};
const subscribe = async (env, key, url, events) => (await api(env, subs, 'POST', '/api/v1/webhooks', key, events ? { url, events } : { url })).data;
const rows = (db) => db.prepare(`SELECT d.status, d.attempts, d.next_attempt_at AS next, d.last_error AS err, s.url FROM webhook_deliveries d JOIN webhook_subscriptions s ON s.id = d.subscription_id ORDER BY s.url, d.created_at, d.id`).all();

// ──────────────────────────────────────────────────────────────────────────────
console.log('\nsubscribing');
{
  const { db, env } = fresh();
  const live = await addKey(db, 'k1', 'u1', 'live'); const test = await addKey(db, 'k2', 'u1', 'test'); const other = await addKey(db, 'k3', 'u2', 'live');
  for (const u of ['http://example.com/h', 'https://127.0.0.1/h', 'https://localhost/h', 'https://example.com:8443/h', 'https://user:pw@example.com/h', 'https://vaneapp.dev/api/x',
    'https://example.com/ h', 'https://10-0-0-1.example.com/h', 'https://[::1]/h', 'https://example/h', 'https://metadata.google.internal/h', 'https://169.254.169.254/h', 'https://2130706433/h', 'https://0x7f.0.0.1/h']) {
    const r = await api(env, subs, 'POST', '/api/v1/webhooks', live, { url: u });
    check(`refused: ${u}`, r.status === 400 && r.data.code === 'invalid_url', JSON.stringify(r));
  }
  const ok = await api(env, subs, 'POST', '/api/v1/webhooks', live, { url: 'https://HOOKS.example.com/Vane?x=1' });
  check('a good address is accepted (201) and its host lower-cased', ok.status === 201 && ok.data.webhook.url === 'https://hooks.example.com/Vane?x=1', JSON.stringify(ok.data));
  check('all events by default', JSON.stringify(ok.data.webhook.events) === JSON.stringify(['post.published', 'post.failed']));
  check('the secret is whsec_ + 48 hex and is shown now', /^whsec_[0-9a-f]{48}$/.test(ok.data.secret));
  check('the stored secret is encrypted, not the plain one', db.prepare('SELECT secret FROM webhook_subscriptions').get().secret !== ok.data.secret);
  const dot = await api(env, subs, 'POST', '/api/v1/webhooks', live, { url: 'https://hooks.example.com./Vane?x=1' });
  check('the same address with a dot after the host is the same address (409)', dot.status === 409 && dot.data.code === 'webhook_exists', JSON.stringify(dot));
  const dot2 = await api(env, subs, 'POST', '/api/v1/webhooks', live, { url: 'https://other.example.com./h' });
  check('a trailing dot is stored without it', dot2.status === 201 && dot2.data.webhook.url === 'https://other.example.com/h', JSON.stringify(dot2.data));
  check('the same address twice is refused (409)', (await api(env, subs, 'POST', '/api/v1/webhooks', live, { url: 'https://hooks.example.com/Vane?x=1' })).status === 409);
  for (const e of [['nope'], [], 'post.published', [1], ['post.published', 'x']]) check(`events ${JSON.stringify(e)} refused`, (await api(env, subs, 'POST', '/api/v1/webhooks', live, { url: 'https://e.example.com/h', events: e })).data?.code === 'invalid_events');
  const one = await api(env, subs, 'POST', '/api/v1/webhooks', live, { url: 'https://one.example.com/h', events: ['post.failed', 'post.failed'] });
  check('a list of events is kept without repeats', JSON.stringify(one.data.webhook.events) === JSON.stringify(['post.failed']));
  const list = await api(env, subs, 'GET', '/api/v1/webhooks', live);
  check('the list never shows a secret', list.status === 200 && list.data.webhooks.length === 3 && !JSON.stringify(list.data).includes('whsec_'));
  check("another account sees none of them", (await api(env, subs, 'GET', '/api/v1/webhooks', other)).data.webhooks.length === 0);
  const id = list.data.webhooks[0].id;
  check("another account cannot delete mine (404)", (await api(env, subId, 'DELETE', `/api/v1/webhooks/${id}`, other, undefined, { id })).status === 404);
  check('a test key checks and answers like live, but saves nothing', await (async () => {
    const before = db.prepare('SELECT COUNT(*) n FROM webhook_subscriptions').get().n;
    const r = await api(env, subs, 'POST', '/api/v1/webhooks', test, { url: 'https://t.example.com/h' });
    return r.status === 201 && r.data.test === true && /^whsec_/.test(r.data.secret) && db.prepare('SELECT COUNT(*) n FROM webhook_subscriptions').get().n === before;
  })());
  check('a test key DELETE changes nothing', (await api(env, subId, 'DELETE', `/api/v1/webhooks/${id}`, test, undefined, { id })).data.test === true && db.prepare('SELECT COUNT(*) n FROM webhook_subscriptions').get().n === 3);
  check('the owner can delete (200), and only once (404)', (await api(env, subId, 'DELETE', `/api/v1/webhooks/${id}`, live, undefined, { id })).status === 200 && (await api(env, subId, 'DELETE', `/api/v1/webhooks/${id}`, live, undefined, { id })).status === 404);
  check('a malformed id is a 404', (await api(env, subId, 'DELETE', '/api/v1/webhooks/xyz', live, undefined, { id: 'xyz' })).status === 404);
  let last = null; for (let i = 0; i < 12; i++) { last = await api(env, subs, 'POST', '/api/v1/webhooks', live, { url: `https://h${i}.example.com/x` }); if (last.status !== 201) break; }
  check('at most 10 subscriptions per account (409 too_many_webhooks)', last.status === 409 && last.data.code === 'too_many_webhooks' && db.prepare('SELECT COUNT(*) n FROM webhook_subscriptions').get().n === 10);
}
{
  const { db, env } = fresh(); const live = await addKey(db, 'k1', 'u1', 'live');
  db.exec('DROP TABLE webhook_deliveries; DROP TABLE webhook_subscriptions;');
  check('without the webhook tables the API says so (503) instead of failing', (await api(env, subs, 'GET', '/api/v1/webhooks', live)).status === 503 && (await api(env, subs, 'POST', '/api/v1/webhooks', live, { url: 'https://x.example.com/h' })).status === 503);
  addPost(db, 'p1');
  check('and posting is not disturbed: queuing an event just returns 0', await wh.enqueueWebhookEvent(env, 'u1', 'p1', 'post.published', NOW) === 0);
}

// ──────────────────────────────────────────────────────────────────────────────
console.log('\nthe outbox and the payload');
{
  const { db, env } = fresh(); const live = await addKey(db, 'k1', 'u1', 'live');
  await subscribe(env, live, 'https://a.example.com/hook'); await subscribe(env, live, 'https://b.example.com/hook', ['post.failed']);
  addPost(db, 'p1');
  check('"post.published" is queued only for subscriptions that want it', await wh.enqueueWebhookEvent(env, 'u1', 'p1', 'post.published', NOW) === 1);
  check('"post.failed" for both', await wh.enqueueWebhookEvent(env, 'u1', 'p1', 'post.failed', NOW) === 2);
  check('an unknown post queues nothing', await wh.enqueueWebhookEvent(env, 'u1', 'nope', 'post.published', NOW) === 0);
  check("someone else's subscriptions get nothing for my post", await wh.enqueueWebhookEvent(env, 'u2', 'p1', 'post.published', NOW) === 0);
  const raw = db.prepare(`SELECT id, payload FROM webhook_deliveries WHERE event = 'post.published'`).get();
  const pl = JSON.parse(raw.payload);
  check('the body is { id, type, createdAt, data.post } and the id is the delivery id', pl.id === raw.id && pl.type === 'post.published' && pl.createdAt === new Date(NOW * 1000).toISOString() && !!pl.data.post);
  check('the post looks like GET /api/v1/posts/:id', ['id', 'groupId', 'channelId', 'channelName', 'platform', 'content', 'status', 'sentAt', 'url'].every((k) => k in pl.data.post) && pl.data.post.status === 'sent');
  check('no credentials and no account data are in the body', !raw.payload.includes('SECRET-CREDENTIALS-BLOB') && !raw.payload.includes('a@example.com') && !/"user_?id"/i.test(raw.payload));
  check('text with quotes, brackets and non-latin letters survives', pl.data.post.content === 'Hello <world> "quotes" é中');
}

// ──────────────────────────────────────────────────────────────────────────────
console.log('\nsending and signing');
{
  const { db, env } = fresh(); const live = await addKey(db, 'k1', 'u1', 'live');
  const A = await subscribe(env, live, 'https://a.example.com/hook');
  addPost(db, 'p1'); await wh.enqueueWebhookEvent(env, 'u1', 'p1', 'post.published', NOW);
  sent.length = 0; behaviour = () => ({ status: 200 });
  const r = await wh.deliverDueWebhooks(env, NOW);
  const d = sent[0];
  check('one delivery is sent and marked delivered', r.delivered === 1 && sent.length === 1 && db.prepare(`SELECT status FROM webhook_deliveries`).get().status === 'delivered');
  check('it is a POST of JSON, redirects off, with a Vane user agent', d.init.method === 'POST' && d.init.headers['Content-Type'] === 'application/json' && d.init.redirect === 'manual' && d.init.headers['User-Agent'] === 'Vane-Webhooks/1');
  check('Vane-Event and Vane-Delivery name the event and the delivery', d.init.headers['Vane-Event'] === 'post.published' && d.init.headers['Vane-Delivery'] === JSON.parse(d.init.body).id);
  check('Vane-Signature is an HMAC-SHA256 of "<t>.<raw body>" with the secret (independent check)', sigOk(d, A.secret));
  check('a wrong secret does not verify', !sigOk(d, 'whsec_wrong'));
  check('the timestamp in the signature is the moment of sending', Math.abs(Number(/t=(\d+)/.exec(d.init.headers['Vane-Signature'])[1]) - Date.now() / 1000) < 5);
  if (docsVerify) {
    check('the Node.js sample on the developers page accepts the real delivery', docsVerify(A.secret, d.init.headers['Vane-Signature'], d.init.body) === true);
    check('…rejects a wrong secret', docsVerify('whsec_wrong', d.init.headers['Vane-Signature'], d.init.body) === false);
    check('…rejects a changed body', docsVerify(A.secret, d.init.headers['Vane-Signature'], d.init.body + ' ') === false);
    check('…rejects a delivery older than 5 minutes (replay)', docsVerify(A.secret, `t=${Math.floor(Date.now() / 1000) - 400},v1=${'0'.repeat(64)}`, d.init.body) === false);
    check('…rejects a malformed header without throwing', docsVerify(A.secret, 'garbage', d.init.body) === false);
  } else check('the developers page has a Node.js verify sample', false, 'not found in site/developers.html');
  check('nothing is sent twice: the next run finds nothing due', (await wh.deliverDueWebhooks(env, NOW + 5)).delivered === 0 && sent.length === 1);
}
{
  const { db, env } = fresh(); const live = await addKey(db, 'k1', 'u1', 'live');
  await subscribe(env, live, 'https://a.example.com/hook');
  addPost(db, 'p1'); await wh.enqueueWebhookEvent(env, 'u1', 'p1', 'post.published', NOW);
  const noKey = { ...env, ENCRYPTION_KEY: 'short' };
  sent.length = 0;
  const logged = []; const realErr = console.error; console.error = (...a) => logged.push(a.join(' '));
  const r = await wh.deliverDueWebhooks(noKey, NOW);
  check('without a proper ENCRYPTION_KEY nothing is sent', JSON.stringify(r) === JSON.stringify({ delivered: 0, retried: 0, failed: 0 }) && sent.length === 0);
  check('…and the worker log says why, naming the fix (it used to be silent)', logged.length === 1 && /ENCRYPTION_KEY/.test(logged[0]) && /cron:secret/.test(logged[0]), JSON.stringify(logged));
  check('…the queued delivery is left alone, so it goes out once the key is there', db.prepare(`SELECT status, attempts FROM webhook_deliveries`).get().status === 'pending' && db.prepare(`SELECT attempts FROM webhook_deliveries`).get().attempts === 0);
  const { env: quietEnv } = fresh();
  logged.length = 0; await wh.deliverDueWebhooks({ ...quietEnv, ENCRYPTION_KEY: undefined }, NOW);
  console.error = realErr;
  check('with nothing queued the worker stays quiet every minute', logged.length === 0);
}

// ──────────────────────────────────────────────────────────────────────────────
console.log('\nretries');
{
  const { db, env } = fresh(); const live = await addKey(db, 'k1', 'u1', 'live');
  await subscribe(env, live, 'https://a.example.com/hook');
  addPost(db, 'p1'); await wh.enqueueWebhookEvent(env, 'u1', 'p1', 'post.failed', NOW);
  sent.length = 0; behaviour = () => ({ status: 500 });
  let t = NOW; const waits = []; const ids = new Set();
  for (let i = 0; i < 8; i++) {
    const before = sent.length; await wh.deliverDueWebhooks(env, t);
    for (const x of sent.slice(before)) ids.add(x.init.headers['Vane-Delivery']);
    const row = rows(db)[0];
    if (row.status !== 'pending') break;
    waits.push(row.next - t); t = row.next;
  }
  const row = rows(db)[0];
  check('retries wait 1 min, 5 min, 30 min, 2 h, 12 h', JSON.stringify(waits) === JSON.stringify([60, 300, 1800, 7200, 43200]), JSON.stringify(waits));
  check('then it gives up: 6 attempts, status failed, with the reason', row.status === 'failed' && row.attempts === 6 && /HTTP 500/.test(row.err) && sent.length === 6);
  check('every retry carries the same Vane-Delivery id', ids.size === 1);
  check('nothing happens after it gave up', (await wh.deliverDueWebhooks(env, t + 999999)).delivered === 0 && sent.length === 6);
  check('the subscription shows the last status', db.prepare('SELECT last_status s FROM webhook_subscriptions').get().s === 500);
}
for (const [label, b, expectRetry] of [
  ['a redirect (301) is not followed and counts as a failure', { status: 301, headers: { location: 'https://evil.example.com/' } }, true],
  ['a connection error is retried', { throw: new TypeError('fetch failed') }, true],
  ['a timeout is retried', { throw: Object.assign(new Error('t'), { name: 'TimeoutError' }) }, true],
  ['a 429 is retried', { status: 429 }, true],
  ['a 204 is delivered', { status: 204 }, false],
  ['a 202 is delivered', { status: 202 }, false],
]) {
  const { db, env } = fresh(); const live = await addKey(db, 'k1', 'u1', 'live');
  await subscribe(env, live, 'https://a.example.com/hook'); addPost(db, 'p1'); await wh.enqueueWebhookEvent(env, 'u1', 'p1', 'post.published', NOW);
  sent.length = 0; behaviour = () => b;
  const r = await wh.deliverDueWebhooks(env, NOW);
  check(label, expectRetry ? r.retried === 1 && rows(db)[0].status === 'pending' && sent.length === 1 : r.delivered === 1 && rows(db)[0].status === 'delivered');
}
{
  const cases = [
    ['429 with Retry-After: 600 waits 10 minutes', { status: 429, headers: { 'retry-after': '600' } }, 600],
    ['503 with Retry-After: 120 waits 2 minutes', { status: 503, headers: { 'retry-after': '120' } }, 120],
    ['a Retry-After shorter than our own delay is not used', { status: 429, headers: { 'retry-after': '5' } }, 60],
    ['a huge Retry-After is cut to one hour', { status: 429, headers: { 'retry-after': '999999' } }, 3600],
    ['a Retry-After given as a date is ignored', { status: 429, headers: { 'retry-after': 'Wed, 21 Oct 2037 07:28:00 GMT' } }, 60],
    ['Retry-After on a 500 is ignored', { status: 500, headers: { 'retry-after': '3000' } }, 60],
  ];
  for (const [label, b, want] of cases) {
    const { db, env } = fresh(); const live = await addKey(db, 'k1', 'u1', 'live');
    await subscribe(env, live, 'https://a.example.com/hook'); addPost(db, 'p1'); await wh.enqueueWebhookEvent(env, 'u1', 'p1', 'post.published', NOW);
    behaviour = () => b; await wh.deliverDueWebhooks(env, NOW);
    check(label, rows(db)[0].next - NOW === want, `got ${rows(db)[0].next - NOW}`);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
console.log('\n410 Gone ends the subscription');
{
  const { db, env } = fresh(); const live = await addKey(db, 'k1', 'u1', 'live');
  await subscribe(env, live, 'https://a.example.com/hook'); await subscribe(env, live, 'https://b.example.com/hook');
  addPost(db, 'p1');
  for (let i = 0; i < 4; i++) await wh.enqueueWebhookEvent(env, 'u1', 'p1', 'post.published', NOW + i);
  sent.length = 0; behaviour = (u) => (u.includes('//a.') ? { status: 410 } : { status: 200 });
  const r = await wh.deliverDueWebhooks(env, NOW + 10);
  const toA = sent.filter((x) => x.url.includes('//a.')).length;
  check('the receiver is called once, not once per queued event', toA === 1, `calls to a: ${toA}`);
  check('the subscription is disabled with status 410', db.prepare(`SELECT disabled_at d, last_status s FROM webhook_subscriptions WHERE url LIKE '%//a.%'`).get().s === 410 && db.prepare(`SELECT disabled_at d FROM webhook_subscriptions WHERE url LIKE '%//a.%'`).get().d !== null);
  check('every queued event of it is closed (failed), none stays pending', rows(db).filter((x) => x.url.includes('//a.')).every((x) => x.status === 'failed'));
  check('the other subscription is not affected: all 4 delivered', rows(db).filter((x) => x.url.includes('//b.')).every((x) => x.status === 'delivered') && r.delivered === 4);
  check('the run counts them: 4 delivered, 4 failed', r.failed === 4, JSON.stringify(r));
  check('a disabled subscription gets no new events', await wh.enqueueWebhookEvent(env, 'u1', 'p1', 'post.published', NOW + 20) === 1);
  const list = await api(env, subs, 'GET', '/api/v1/webhooks', live);
  check('the list shows it as disabled', list.data.webhooks.find((w) => w.url.includes('//a.')).disabled === true);
}
{
  // a 410 while many events are still queued for the same receiver and not even claimed yet
  const { db, env } = fresh(); const live = await addKey(db, 'k1', 'u1', 'live');
  await subscribe(env, live, 'https://a.example.com/hook'); addPost(db, 'p1');
  for (let i = 0; i < 9; i++) await wh.enqueueWebhookEvent(env, 'u1', 'p1', 'post.published', NOW + i);
  sent.length = 0; behaviour = () => ({ status: 410 });
  await wh.deliverDueWebhooks(env, NOW + 20);
  check('events that were not even picked up yet are closed too (none left pending)', rows(db).every((x) => x.status === 'failed') && rows(db).length === 9, JSON.stringify(rows(db).map((x) => x.status)));
}

// ──────────────────────────────────────────────────────────────────────────────
console.log('\nfairness: parallel delivery, order, overlapping runs');
{
  const { db, env } = fresh(); const live = await addKey(db, 'k1', 'u1', 'live');
  for (let i = 0; i < 6; i++) await subscribe(env, live, `https://s${i}.example.com/hook`);
  addPost(db, 'p1'); await wh.enqueueWebhookEvent(env, 'u1', 'p1', 'post.published', NOW);
  sent.length = 0; behaviour = () => ({ status: 200, delay: 120 });
  const t0 = Date.now(); const r = await wh.deliverDueWebhooks(env, NOW);
  const took = Date.now() - t0;
  check('6 receivers that each take 120 ms are called in parallel (about 120 ms, not 720)', r.delivered === 6 && took < 450, `took ${took} ms`);
}
{
  const { db, env } = fresh(); const live = await addKey(db, 'k1', 'u1', 'live');
  await subscribe(env, live, 'https://slow.example.com/hook'); await subscribe(env, live, 'https://fast.example.com/hook');
  addPost(db, 'p1'); for (let i = 0; i < 12; i++) await wh.enqueueWebhookEvent(env, 'u1', 'p1', 'post.published', NOW + i);
  sent.length = 0; behaviour = (u) => (u.includes('slow') ? { status: 200, delay: 60 } : { status: 200 });
  let t0 = Date.now(); await wh.deliverDueWebhooks(env, NOW + 100);
  const fastDone = sent.filter((x) => x.url.includes('fast')).length, slowDone = sent.filter((x) => x.url.includes('slow')).length;
  check('one run sends at most 5 events to one receiver (fast: 5, slow: 5)', fastDone === 5 && slowDone === 5, `fast ${fastDone}, slow ${slowDone}`);
  check('a fast receiver is not held up by a slow one', Math.max(...sent.filter((x) => x.url.includes('fast')).map((x) => x.t)) - t0 < 100);
  await wh.deliverDueWebhooks(env, NOW + 101); await wh.deliverDueWebhooks(env, NOW + 102);
  check('the rest follows in the next runs: all 24 delivered, none twice', rows(db).every((x) => x.status === 'delivered') && sent.length === 24);
}
{
  const { db, env } = fresh(); const live = await addKey(db, 'k1', 'u1', 'live');
  await subscribe(env, live, 'https://a.example.com/hook'); addPost(db, 'p1');
  for (let i = 0; i < 4; i++) await wh.enqueueWebhookEvent(env, 'u1', 'p1', 'post.published', NOW + i);
  sent.length = 0; behaviour = () => ({ status: 200, delay: 10 });
  await wh.deliverDueWebhooks(env, NOW + 10);
  const order = sent.map((x) => JSON.parse(x.init.body).createdAt);
  check("a subscription's events are sent in the order they happened", JSON.stringify(order) === JSON.stringify([...order].sort()) && order.length === 4, JSON.stringify(order));
}
{
  const { db, env } = fresh(); const live = await addKey(db, 'k1', 'u1', 'live');
  for (let i = 0; i < 4; i++) await subscribe(env, live, `https://o${i}.example.com/hook`);
  addPost(db, 'p1'); for (let i = 0; i < 3; i++) await wh.enqueueWebhookEvent(env, 'u1', 'p1', 'post.published', NOW);
  sent.length = 0; behaviour = () => ({ status: 200, delay: 30 });
  await Promise.all([wh.deliverDueWebhooks(env, NOW + 1), wh.deliverDueWebhooks(env, NOW + 1), wh.deliverDueWebhooks(env, NOW + 1)]);
  const perId = new Map(); for (const x of sent) perId.set(x.init.headers['Vane-Delivery'], (perId.get(x.init.headers['Vane-Delivery']) ?? 0) + 1);
  check('three overlapping runs send each of the 12 deliveries exactly once', sent.length === 12 && [...perId.values()].every((n) => n === 1), `sent ${sent.length}`);
}

// ──────────────────────────────────────────────────────────────────────────────
console.log('\nclean-up');
{
  const { db, env } = fresh(); const live = await addKey(db, 'k1', 'u1', 'live');
  await subscribe(env, live, 'https://a.example.com/hook'); await subscribe(env, live, 'https://dead.example.com/hook');
  addPost(db, 'p1'); await wh.enqueueWebhookEvent(env, 'u1', 'p1', 'post.published', NOW); await wh.enqueueWebhookEvent(env, 'u1', 'p1', 'post.published', NOW);
  db.exec(`UPDATE webhook_deliveries SET status = 'delivered' WHERE subscription_id IN (SELECT id FROM webhook_subscriptions WHERE url LIKE '%//a.%')`);
  db.exec(`UPDATE webhook_subscriptions SET disabled_at = ${NOW} WHERE url LIKE '%//dead.%'`);
  await wh.purgeOldWebhookDeliveries(env, NOW + 3 * 86400);
  check('nothing is removed in the first days', db.prepare('SELECT COUNT(*) n FROM webhook_deliveries').get().n === 4);
  await wh.purgeOldWebhookDeliveries(env, NOW + 8 * 86400);
  check('after a week finished deliveries are removed, and so is what was still queued for a disabled subscription', db.prepare('SELECT COUNT(*) n FROM webhook_deliveries').get().n === 0);
  await wh.enqueueWebhookEvent(env, 'u1', 'p1', 'post.published', NOW + 8 * 86400);
  await wh.purgeOldWebhookDeliveries(env, NOW + 30 * 86400);
  check('a pending delivery of a working subscription is never purged', db.prepare(`SELECT COUNT(*) n FROM webhook_deliveries WHERE status = 'pending'`).get().n === 1);
}

globalThis.fetch = realFetch;
rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
