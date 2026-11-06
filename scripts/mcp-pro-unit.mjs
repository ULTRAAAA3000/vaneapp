#!/usr/bin/env node
/**
 * The advanced MCP tools of the paid plans, end to end: JSON-RPC requests to the real MCP handler (functions/api/v1/mcp.ts) with real
 * API keys, on an in-memory SQLite copy of schema.sql. No network.  npm run test:unit
 */
import { build } from 'esbuild';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'vane-unit-'));
const out = join(dir, 'mcp.mjs');
await build({
  stdin: { contents: "export { onRequestPost } from './functions/api/v1/mcp.ts'; export { generateApiKey } from './functions/api/lib/apikeys.ts'; export * from './functions/api/lib/mcppro.ts'; export * from './functions/api/lib/keylimit.ts';", resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent',
});
const m = await import(pathToFileURL(out).href);
rmSync(dir, { recursive: true, force: true });

const NOW = Math.floor(Date.now() / 1000);
const db = new DatabaseSync(':memory:');
db.exec(readFileSync('schema.sql', 'utf8'));
db.exec(`UPDATE plans SET is_active = 1, coming_soon = 0 WHERE id = 'suite'`);          // what the admin does to switch the Suite on
db.exec(`INSERT INTO users (id, email, timezone) VALUES ('paid', 'p@example.com', 'Europe/Kyiv'), ('free', 'f@example.com', 'UTC'), ('suite', 's@example.com', 'UTC'), ('devapi', 'd@example.com', 'UTC')`);
db.exec(`INSERT INTO subscriptions (user_id, plan, status, current_period_end) VALUES ('paid', 'pro', 'active', ${NOW + 86400 * 20}), ('suite', 'suite', 'active', ${NOW + 86400 * 20}), ('devapi', 'api', 'active', ${NOW + 86400 * 20})`);
// like D1: bind() returns a NEW statement, so one prepared statement can be bound many times (the post insert does exactly that)
const wrap = (sql) => { const make = (args) => ({
  bind: (...a) => make(a),
  async first() { return db.prepare(sql).get(...args) ?? null; },
  async run() { const r = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes) } }; },
  async all() { return { results: db.prepare(sql).all(...args) }; },
  _exec() { return db.prepare(sql).run(...args); },
}); return make([]); };
const env = { MODERATION_OFF: '1', ENCRYPTION_KEY: 'k'.repeat(40), DB: { prepare: wrap, async batch(list) { db.exec('BEGIN'); try { for (const s of list) s._exec(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } return []; } } };

const keys = {};
for (const [user, mode] of [['paid', 'test'], ['free', 'test'], ['suite', 'live'], ['devapi', 'live']]) {
  const k = await m.generateApiKey('post', mode);
  db.prepare(`INSERT INTO api_keys (id, user_id, name, scope, mode, key_hash, hint) VALUES (?, ?, 'k', 'post', ?, ?, ?)`).run(`key-${user}`, user, mode, k.hash, k.hint);
  keys[user] = k.secret;
}
const ch = {};
for (const u of ['paid', 'free', 'suite', 'devapi']) {
  ch[u] = { tg: crypto.randomUUID(), bs: crypto.randomUUID() };             // the API only accepts real channel ids (uuid)
  db.prepare(`INSERT INTO channels (id, user_id, type, name, credentials) VALUES (?, ?, 'telegram', 'My Telegram', '{}'), (?, ?, 'bluesky', 'My Bluesky', '{}')`).run(ch[u].tg, u, ch[u].bs, u);
}
// measured history for "paid": 10 sent posts, the long ones with media doing better
let n = 0;
for (let i = 0; i < 10; i++) {
  const id = `h${++n}`;
  const at = NOW - (i + 2) * 86400 + (i % 2 ? 9 : 18) * 3600 - (NOW % 86400);
  db.prepare(`INSERT INTO posts (id, group_id, user_id, channel_id, content, media_keys, scheduled_at, sent_at, status) VALUES (?, ?, 'paid', ?, ?, ?, ?, ?, 'sent')`).run(id, `g${n}`, ch.paid.tg, 'x'.repeat(i < 5 ? 60 : 240) + ` post ${i}`, i < 5 ? '[]' : '["a.jpg"]', at, at);
  db.prepare(`INSERT INTO post_metrics (post_id, stage, taken_at, views, likes, replies, reposts) VALUES (?, 1, ?, ?, ?, ?, ?)`).run(id, at + 600, 100 + i * 10, i < 5 ? 2 : 12, i < 5 ? 0 : 2, i < 5 ? 0 : 1);
}

let passed = 0;
const failed = [];
const check = (name, cond) => { if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed.push(name); console.log(`  ✗ ${name}`); } };
const quiet = console.error; console.error = () => {};
let rpcId = 0;
async function rpc(user, method, params) {
  const req = new Request('https://x.dev/api/v1/mcp', { method: 'POST', headers: { authorization: `Bearer ${keys[user]}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
  const res = await m.onRequestPost({ request: req, env, waitUntil: () => {} });
  return res.json();
}
const call = async (user, name, args = {}) => (await rpc(user, 'tools/call', { name, arguments: args })).result;
const txt = (r) => r.content.map((c) => c.text).join('\n');
const postCount = (u) => db.prepare(`SELECT COUNT(*) AS n FROM posts WHERE user_id = ? AND status = 'scheduled'`).get(u).n;

console.log('\nwho sees which tools');
{
  const free = (await rpc('free', 'tools/list')).result.tools.map((t) => t.name);
  const paid = (await rpc('paid', 'tools/list')).result.tools.map((t) => t.name);
  check('the Free Trial sees the three basic tools only', free.join() === 'vane_list_channels,vane_list_posts,vane_create_post');
  check('a paid plan also sees the four advanced ones', paid.length === 7 && ['vane_analyze_performance', 'vane_best_times', 'vane_get_voice', 'vane_create_series'].every((t) => paid.includes(t)));
  check('every advanced tool has a title, a schema and read-only hints where they apply', (await rpc('paid', 'tools/list')).result.tools.filter((t) => t.name !== 'vane_create_series' && t.name.startsWith('vane_') && !['vane_create_post'].includes(t.name)).every((t) => t.annotations.readOnlyHint === true && t.inputSchema.type === 'object'));
  const dev = (await rpc('devapi', 'tools/list')).result.tools.map((t) => t.name);
  check('the Developer API plan (no dashboard) keeps the basic tools', dev.length === 3);
  const r = await call('free', 'vane_best_times');
  check('calling a paid tool by name on the Free Trial is refused, in words the assistant can pass on', r.isError === true && /paid plans/i.test(txt(r)));
  const prompts = (r2) => r2.result.prompts.map((p) => p.name);
  check('the /analyze and /series commands exist for paid accounts only', prompts(await rpc('paid', 'prompts/list')).includes('series') && !prompts(await rpc('free', 'prompts/list')).includes('series'));
  const ins = (u) => rpc(u, 'initialize', { protocolVersion: '2025-06-18' }).then((x) => x.result.instructions);
  check('the instructions mention the advanced tools on a paid plan only', /vane_create_series/.test(await ins('paid')) && !/vane_create_series/.test(await ins('free')));
  const basic = await call('free', 'vane_list_channels');
  check('the basic tools still work on the Free Trial', !basic.isError && /My Telegram/.test(txt(basic)));
}

console.log('\nvane_analyze_performance');
{
  const r = await call('paid', 'vane_analyze_performance', { days: 30 });
  const t = txt(r);
  check('it reports the counts and what "reactions" means', !r.isError && /10 sent posts/.test(t) && /10 with measured results/.test(t) && /likes \+ replies \+ reposts/.test(t));
  check('it lists best and weakest posts and the patterns with their sample sizes', /Best posts:/.test(t) && /Weakest posts:/.test(t) && /Length:/.test(t) && /\(5 posts\)/.test(t));
  check('the posts with media did better, and the numbers say so (media 15 vs text only 2)', /with media: 15 reactions on average \(5 posts\)/.test(t) && /text only: 2 reactions on average \(5 posts\)/.test(t));
  check('it leaves the advice to the assistant and warns about correlation', /correlation is not proof/.test(t));
  const none = await call('suite', 'vane_analyze_performance');
  check('an account without sent posts is told there is nothing to analyse (no invented numbers)', /nothing to analyse/.test(txt(none)));
}

console.log('\nvane_best_times');
{
  const r = await call('paid', 'vane_best_times', { count: 3, timezone: 'Europe/Kyiv' });
  const lines = txt(r).split('\n').filter((l) => /^\d\. /.test(l));
  check('three future slots, with their local time', !r.isError && lines.length === 3 && lines.every((l) => Date.parse(l.slice(3, 27)) > Date.now()) && /Europe\/Kyiv/.test(txt(r)));
  const d = await call('suite', 'vane_best_times', { count: 2 });
  check('with no measured results it says the times are defaults, not personal', /defaults/i.test(txt(d)) && /do not present them as personal/i.test(txt(d)));
  const bad = await call('paid', 'vane_best_times', { count: 2, timezone: 'Not/AZone' });
  check('an unknown time zone falls back to the account\'s own instead of failing', !bad.isError && /Europe\/Kyiv/.test(txt(bad)));
}

console.log('\nvane_get_voice');
{
  const none = await call('suite', 'vane_get_voice');
  check('no saved voice and too few posts: it says so', /No tone of voice is saved/.test(txt(none)) && !none.isError);
  db.prepare(`INSERT INTO ai_voice (user_id, description, samples, enabled) VALUES ('paid', 'Short, dry, no exclamation marks.', '["Shipped the thing. It works.","Fixed two bugs, broke one."]', 1)`).run();
  const r = await call('paid', 'vane_get_voice');
  check('a saved voice comes back with its notes and examples, as a style reference only', /Short, dry/.test(txt(r)) && /Shipped the thing/.test(txt(r)) && /style reference/i.test(txt(r)));
}

console.log('\nvane_create_series');
{
  const posts = [{ text: 'Day one of the series' }, { text: 'Day two of the series' }, { text: 'Day three of the series' }];
  const before = postCount('suite');
  const dry = await call('suite', 'vane_create_series', { posts, channels: ['telegram', 'bluesky'], dry_run: true });
  check('a dry run shows the plan and schedules nothing', /DRY RUN/.test(txt(dry)) && /Day two/.test(txt(dry)) && postCount('suite') === before);

  const start = new Date(Date.now() + 2 * 86400_000).toISOString();
  const real = await call('suite', 'vane_create_series', { posts, channels: ['telegram', 'bluesky'], start, every_hours: 24 });
  const rows = db.prepare(`SELECT scheduled_at, content, channel_id FROM posts WHERE user_id = 'suite' AND status = 'scheduled' ORDER BY scheduled_at, channel_id`).all();
  check('three posts on two channels are scheduled in one call (six rows)', !real.isError && /3 of 3 posts scheduled/.test(txt(real)) && rows.length === 6);
  const t0 = Math.floor(Date.parse(start) / 1000);
  check('on the start and then every 24 hours', [...new Set(rows.map((r) => r.scheduled_at))].join() === [t0, t0 + 86400, t0 + 2 * 86400].join());
  const again = await call('suite', 'vane_create_series', { posts, channels: ['telegram', 'bluesky'], start, every_hours: 24 });
  check('calling it again with the same posts does not post twice', !again.isError && db.prepare(`SELECT COUNT(*) AS n FROM posts WHERE user_id = 'suite'`).get().n === 6);

  const tooMany = await call('suite', 'vane_create_series', { posts: Array.from({ length: 15 }, (_, i) => ({ text: `p${i}` })), channels: ['telegram'] });
  check('more than 14 posts in one call is refused', tooMany.isError && /at most 14/.test(txt(tooMany)));
  const unknown = await call('suite', 'vane_create_series', { posts: [{ text: 'hi there' }], channels: ['mastodon'] });
  check('an unknown channel is refused with the list of connected ones', unknown.isError && /No such channel: mastodon/.test(txt(unknown)) && /My Telegram/.test(txt(unknown)));
  const past = await call('suite', 'vane_create_series', { posts: [{ text: 'a fine post' }, { text: 'a late post', scheduled_at: '2020-01-01T00:00:00Z' }], channels: ['telegram'] });
  check('a time in the past stops the WHOLE series before anything is made', past.isError && /Post 2/.test(txt(past)) && db.prepare(`SELECT COUNT(*) AS n FROM posts WHERE user_id = 'suite'`).get().n === 6);
  const empty = await call('suite', 'vane_create_series', { posts: [{ text: '   ' }], channels: ['telegram'] });
  check('an empty text is refused', empty.isError && /no text/.test(txt(empty)));

  const auto = await call('suite', 'vane_create_series', { posts: [{ text: 'Auto one' }, { text: 'Auto two' }], channels: ['bluesky'] });
  const autoRows = db.prepare(`SELECT scheduled_at FROM posts WHERE user_id = 'suite' AND content LIKE 'Auto %' ORDER BY scheduled_at`).all();
  check('with no times given it uses the best free slots, in the future and in order', !auto.isError && autoRows.length === 2 && autoRows[0].scheduled_at > NOW && autoRows[1].scheduled_at > autoRows[0].scheduled_at);

  const testKey = await call('paid', 'vane_create_series', { posts: [{ text: 'Only a test' }], channels: ['telegram'], start });
  check('a test key checks everything and posts nothing', /TEST MODE/.test(txt(testKey)) && postCount('paid') === 0);
}

console.log('\nroom for keys (one per assistant and environment)');
{
  const room = async (u) => m.maxKeysFor(env, u);
  check('the Free Trial may have 3 active keys, a paid plan 10', (await room('free')) === 3 && (await room('paid')) === 10 && (await room('suite')) === 10);
  check('the Developer API plan, which is all about keys, has the full 10 too', (await room('devapi')) === 10);
}

console.log('\nthe agent log sees the new tools');
{
  const lines = db.prepare(`SELECT message FROM agent_events WHERE user_id = 'suite' ORDER BY id`).all().map((r) => r.message);
  check('a series leaves a line with counts and the first time, never the text', lines.some((l) => /vane_create_series\(3 posts, 2 channels\) → 3 posts scheduled, first/.test(l)) && !lines.some((l) => /Day one/.test(l)));
  check('a refusal is logged with its reason', lines.some((l) => /vane_create_series.*refused: too many posts/.test(l)));
}

console.error = quiet;
console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
