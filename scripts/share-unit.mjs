#!/usr/bin/env node
/**
 * Apple Shortcuts / share endpoint POST /api/v1/share on the REAL handler and the REAL schema.sql (in-memory SQLite):
 * what a share sheet sends (JSON, plain text, form) becomes one scheduled post; channel picking, delay, test keys, quota, retries.   npm run test:unit
 */
import { build } from 'esbuild';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'vane-unit-'));
const root = process.cwd();
writeFileSync(join(dir, 'entry.ts'), [
  `export * as share from '${root}/functions/api/v1/share.ts';`,
  `export * as keys from '${root}/functions/api/lib/apikeys.ts';`,
  `export * as integrations from '${root}/functions/api/lib/integrations.ts';`,
  `export * as settings from '${root}/functions/api/lib/settings.ts';`,
].join('\n'));
await build({ entryPoints: [join(dir, 'entry.ts')], bundle: true, format: 'esm', platform: 'node', outfile: join(dir, 'all.mjs'), logLevel: 'silent' });
const { share, keys, integrations, settings } = await import(pathToFileURL(join(dir, 'all.mjs')).href);
rmSync(dir, { recursive: true, force: true });

let passed = 0;
const failed = [];
const check = (name, cond, extra = '') => { if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed.push(name); console.log(`  ✗ ${name} ${extra}`); } };

const C1 = '11111111-1111-4111-8111-111111111111';
const C2 = '22222222-2222-4222-8222-222222222222';
const C3 = '33333333-3333-4333-8333-333333333333';
const FOREIGN = '44444444-4444-4444-8444-444444444444';
const NOW = Math.floor(Date.now() / 1000);

async function make({ plan = 'api', mode = 'live', channels = [[C1, 'telegram', 'Vane News']], used = {} } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(readFileSync('schema.sql', 'utf8'));
  const mk = (sql) => ({
    args: [],
    bind(...a) { const c = mk(sql); c.args = a; return c; },
    async first() { return db.prepare(sql).get(...this.args) ?? null; },
    async run() { const r = db.prepare(sql).run(...this.args); return { success: true, meta: { changes: Number(r.changes) } }; },
    async all() { return { results: db.prepare(sql).all(...this.args) }; },
  });
  const env = { ENCRYPTION_KEY: 'k'.repeat(40), MODERATION_OFF: '1', DB: { prepare: mk, async batch(stmts) {
    db.exec('BEGIN');
    try { const out = []; for (const s of stmts) out.push(await s.run()); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; }
  } } };
  await settings.saveSettings(env, { enforce_limits: true });
  db.exec(`INSERT INTO users (id, email) VALUES ('u1', 'a@example.com'), ('u2', 'b@example.com')`);
  db.prepare(`INSERT INTO subscriptions (user_id, plan) VALUES ('u1', ?)`).run(plan);
  channels.forEach(([id, type, name], i) => db.prepare(`INSERT INTO channels (id, user_id, type, name, credentials, created_at) VALUES (?, 'u1', ?, ?, 'x', ?)`).run(id, type, name, 100 + i));
  db.exec(`INSERT INTO channels (id, user_id, type, name, credentials) VALUES ('${FOREIGN}', 'u2', 'telegram', 'Other', 'x')`);
  const k = await keys.generateApiKey('post', mode);
  db.prepare(`INSERT INTO api_keys (id, user_id, name, scope, mode, key_hash, hint) VALUES ('k1', 'u1', 'My shortcut', 'post', ?, ?, ?)`).run(mode, k.hash, k.hint);
  if (used.api) db.prepare(`INSERT INTO usage_counters (user_id, period, api_posts) VALUES ('u1', ?, ?)`).run(plan === 'free' ? 'lifetime' : new Date().toISOString().slice(0, 7), used.api);
  return { db, env, secret: k.secret };
}

async function send(f, { body, type = 'application/json', query = '', headers = {}, key = f.secret, method = 'POST' } = {}) {
  const h = { 'cf-connecting-ip': '203.0.113.9', ...headers };
  if (key) h.authorization = `Bearer ${key}`;
  if (type) h['content-type'] = type;
  const req = new Request(`https://vaneapp.dev/api/v1/share${query}`, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const res = share.onRequestPost ? await (method === 'POST' ? share.onRequestPost : share.onRequest)({ request: req, env: f.env, params: {}, waitUntil() {} }) : null;
  let data = null; try { data = await res.clone().json(); } catch { /* */ }
  return { status: res.status, data, headers: res.headers };
}
const rows = (db) => db.prepare(`SELECT content, channel_id c, scheduled_at s, media_keys m FROM posts ORDER BY rowid`).all();

console.log('\nWhat a share sheet sends becomes a post');
{
  const f = await make();
  const r = await send(f, { body: { text: 'Great read', url: 'https://example.org/a' } });
  check('JSON text + url: 201', r.status === 201 && r.data.ok === true, JSON.stringify(r));
  const p = rows(f.db);
  check('one post with the text and the link on separate lines', p.length === 1 && p[0].content === 'Great read\n\nhttps://example.org/a', JSON.stringify(p));
  check('the only channel is chosen without being named', p[0].c === C1);
  check('scheduled 5 minutes ahead by default (time to cancel)', p[0].s >= NOW + 295 && p[0].s <= NOW + 305, String(p[0].s - NOW));
  check('counted as an API post', f.db.prepare(`SELECT api_posts a FROM usage_counters WHERE user_id = 'u1'`).get().a === 1);
}
{
  const f = await make();
  await send(f, { body: { text: 'Look: https://example.org/a', url: 'https://example.org/a', title: 'Look' } });
  check('a link already in the text, and a title already in it, are not repeated', rows(f.db)[0].content === 'Look: https://example.org/a', rows(f.db)[0].content);
  await send(f, { body: { url: 'https://example.org/only' } });
  check('a link alone is a post', rows(f.db)[1].content === 'https://example.org/only');
  await send(f, { body: { title: 'Title', text: 'Body', url: 'https://example.org/z' } });
  check('title, text, link in that order', rows(f.db)[2].content === 'Title\n\nBody\n\nhttps://example.org/z');
}
{
  const f = await make();
  const r = await send(f, { type: 'text/plain', body: 'Just some text', query: '?delay=10' });
  check('plain text body works, options in the query', r.status === 201 && rows(f.db)[0].content === 'Just some text' && rows(f.db)[0].s >= NOW + 595 && rows(f.db)[0].s <= NOW + 605, JSON.stringify(r));
  const g = await send(f, { type: 'application/x-www-form-urlencoded', body: 'text=From+a+form&url=https%3A%2F%2Fexample.org%2Ff' });
  check('form fields work', g.status === 201 && rows(f.db)[1].content === 'From a form\n\nhttps://example.org/f', JSON.stringify(g));
  const n = await send(f, { type: '', body: 'no content type at all' });
  check('no content type is treated as plain text', n.status === 201 && rows(f.db)[2].content === 'no content type at all');
  const bad = await send(f, { type: 'application/pdf', body: 'x' });
  check('an unknown content type: 415', bad.status === 415);
  const q = await send(f, { type: 'text/plain', body: 'hi', query: '?url=https://example.org/q' });
  check('url from the query is appended', rows(f.db)[3].content === 'hi\n\nhttps://example.org/q', JSON.stringify(q.data));
}

console.log('\nEmpty and bad input');
{
  const f = await make();
  const cases = [
    [{ body: {} }, 400, 'empty_share'],
    [{ body: { text: '   ' } }, 400, 'empty_share'],
    [{ type: 'text/plain', body: '' }, 400, 'empty_share'],
    [{ body: '{nope' }, 400, undefined],
    [{ body: [1, 2] }, 400, undefined],
    [{ body: { text: 'x', delayMinutes: 0 } }, 400, 'bad_delay'],
    [{ body: { text: 'x', delayMinutes: 2000 } }, 400, 'bad_delay'],
    [{ body: { text: 'x', delayMinutes: 'soon' } }, 400, 'bad_delay'],
    [{ body: { text: 'x'.repeat(5000) } }, 400, undefined],
    [{ body: 'x'.repeat(20000), type: 'text/plain' }, 413, undefined],
  ];
  for (const [req, status, code] of cases) {
    const r = await send(f, req);
    check(`${status}${code ? ' ' + code : ''}: ${JSON.stringify(req.body).slice(0, 40)}`, r.status === status && (!code || r.data.code === code), JSON.stringify(r));
  }
  check('Telegram text over its limit is refused by the same rules as POST /posts', (await send(f, { body: { text: 'x'.repeat(5000) } })).data.error.includes('too long'));
  check('nothing was saved by any of them', rows(f.db).length === 0);
}

console.log('\nTime');
{
  const f = await make();
  const when = new Date(Date.now() + 3 * 3600_000).toISOString();
  const r = await send(f, { body: { text: 'later', scheduledAt: when } });
  check('scheduledAt is used when given', r.status === 201 && Math.abs(rows(f.db)[0].s - Math.floor(Date.parse(when) / 1000)) <= 1);
  const past = await send(f, { body: { text: 'old', scheduledAt: new Date(Date.now() - 3600_000).toISOString() } });
  check('a time in the past: 400', past.status === 400);
  const d = await send(f, { body: { text: 'delay', delayMinutes: 1440 } });
  check('a day of delay is the maximum and works', d.status === 201);
}

console.log('\nChoosing channels');
{
  const f = await make({ channels: [[C1, 'telegram', 'Vane News'], [C2, 'x', 'Vane X'], [C3, 'telegram', 'Team chat']] });
  const none = await send(f, { body: { text: 'hi' } });
  check('several channels and none named: 400 channel_required, with the list', none.status === 400 && none.data.code === 'channel_required' && none.data.channels.length === 3 && none.data.channels[0].name === 'Vane News', JSON.stringify(none.data));
  check('and nothing was saved', rows(f.db).length === 0);
  check('by exact name (any case)', (await send(f, { body: { text: 'a', channels: ['vane news'] } })).status === 201 && rows(f.db)[0].c === C1);
  check('by platform when it is unique', (await send(f, { body: { text: 'b', channels: 'x' } })).status === 201 && rows(f.db)[1].c === C2);
  const amb = await send(f, { body: { text: 'c', channels: ['telegram'] } });
  check('a platform that matches two channels: 400 channel_ambiguous', amb.status === 400 && amb.data.code === 'channel_ambiguous', JSON.stringify(amb.data));
  const two = await send(f, { body: { text: 'd', channels: 'Vane News, Vane X' } });
  check('a comma-separated string names several channels: one post each, in one group', two.status === 201 && two.data.posts.length === 2 && rows(f.db).length === 4);
  check('by id', (await send(f, { body: { text: 'e', channels: [C3] } })).status === 201 && rows(f.db)[4].c === C3);
  const miss = await send(f, { body: { text: 'f', channels: ['nope'] } });
  check('an unknown name: 404 channel_not_found, with the list', miss.status === 404 && miss.data.code === 'channel_not_found' && miss.data.channels.length === 3);
  check("someone else's channel id cannot be reached", (await send(f, { body: { text: 'g', channels: [FOREIGN] } })).status === 404);
  const dup = await send(f, { body: { text: 'h', channels: ['Vane News', C1, 'vane news'] } });
  check('the same channel named three ways is one post', dup.status === 201 && dup.data.posts.length === 1);
  f.db.prepare(`UPDATE channels SET is_active = 0 WHERE id = '${C3}'`).run();
  check('a disconnected channel cannot be picked', (await send(f, { body: { text: 'i', channels: ['Team chat'] } })).status === 404);
}
{
  const f = await make({ channels: [] });
  const r = await send(f, { body: { text: 'hi' } });
  check('no channels at all: 400 that says to connect one', r.status === 400 && r.data.code === 'channel_required' && /Connect a channel/.test(r.data.error));
}

console.log('\nKeys, quota, retries');
{
  const f = await make();
  check('no key: 401', (await send(f, { body: { text: 'x' }, key: null })).status === 401);
  check('a wrong key: 401', (await send(f, { body: { text: 'x' }, key: 'cpost_live_' + 'a'.repeat(24) })).status === 401);
  check('GET is not allowed: 405', (await send(f, { method: 'GET', type: '' })).status === 405);
}
{
  const f = await make({ mode: 'test', plan: 'free' });
  const r = await send(f, { body: { text: 'try it', url: 'https://example.org/t' } });
  check('a test key answers like a live one and changes nothing', r.status === 201 && r.data.test === true && rows(f.db).length === 0 && r.headers.get('x-vane-mode') === 'test', JSON.stringify(r));
  const bad = await send(f, { body: { text: 'x', channels: ['nope'] } });
  check('and checks the channel like a live one', bad.status === 404);
}
{
  const f = await make({ plan: 'free' });
  const r = await send(f, { body: { text: 'x' } });
  check('the Free Trial can share too (its 30 posts are shared with the API)', r.status === 201 && r.data.usage.api.limit === 30, JSON.stringify(r));
}
{
  const f = await make({ used: { api: 180 } });
  const r = await send(f, { body: { text: 'x' } });
  check('API allowance used up: 402 quota_exceeded, nothing saved', r.status === 402 && r.data.code === 'quota_exceeded' && rows(f.db).length === 0, JSON.stringify(r));
}
{
  const f = await make();
  const a = await send(f, { body: { text: 'once', url: 'https://example.org/i' }, headers: { 'idempotency-key': 'run-1' } });
  const b = await send(f, { body: { text: 'once', url: 'https://example.org/i' }, headers: { 'idempotency-key': 'run-1' } });
  check('the same Idempotency-Key twice: one post, the second answer is a replay', a.status === 201 && b.status === 201 && b.headers.get('idempotent-replayed') === 'true' && rows(f.db).length === 1 && b.data.groupId === a.data.groupId, JSON.stringify([a.status, b.status, rows(f.db).length]));
  check('and only one unit was used', f.db.prepare(`SELECT api_posts a FROM usage_counters WHERE user_id = 'u1'`).get().a === 1);
  const c = await send(f, { body: { text: 'different' }, headers: { 'idempotency-key': 'run-1' } });
  check('the same key with another text is refused (not a silent replay)', c.status >= 400 && rows(f.db).length === 1, String(c.status));
  const p = await Promise.all([1, 2, 3].map(() => send(f, { body: { text: 'parallel' }, headers: { 'idempotency-key': 'run-2' } })));
  check('three parallel runs with one key: exactly one post', rows(f.db).filter((x) => x.content === 'parallel').length === 1, JSON.stringify(p.map((x) => x.status)));
}

console.log('\nAttribution');
{
  check('a User-Agent from the Shortcuts app is recognised', integrations.inferIntegration('Shortcuts/1228.0.2 CFNetwork/1568.100.1 Darwin/24.0.0', 'x') === 'shortcuts');
  check('a key named "iPhone shortcut" is recognised', integrations.inferIntegration(null, 'iPhone shortcut') === 'shortcuts');
  check('other clients are not mistaken for it', integrations.inferIntegration('curl/8', 'my script') === null && integrations.inferIntegration('Obsidian/1.5', 'x') === 'obsidian');
  check('it is a known integration with a name and a catalog entry', integrations.INTEGRATION_IDS.includes('shortcuts') && integrations.INTEGRATION_NAMES.shortcuts === 'Apple Shortcuts' && integrations.catalog('https://vaneapp.dev').some((c) => c.id === 'shortcuts' && c.endpoints[0].value === 'https://vaneapp.dev/api/v1/share'));
  const f = await make();
  await send(f, { body: { text: 'x' }, headers: { 'user-agent': 'Shortcuts/1228 CFNetwork/1568' } });
  const used = f.db.prepare(`SELECT integration, op FROM api_usage_daily`).all();
  check('a share from Shortcuts is counted under Shortcuts', used.some((u) => u.integration === 'shortcuts'), JSON.stringify(used));
}

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) { console.log('Failed:\n - ' + failed.join('\n - ')); process.exit(1); }
