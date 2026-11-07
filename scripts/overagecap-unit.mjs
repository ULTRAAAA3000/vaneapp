#!/usr/bin/env node
/**
 * The monthly ceiling on extra use ($20 by default) and the refund of an extra charge when nothing was delivered, on the REAL
 * handlers and schema.sql (in-memory SQLite).   npm run test:unit
 */
import { build } from 'esbuild';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readdirSync, statSync } from 'node:fs';

const dir = mkdtempSync(join(tmpdir(), 'vane-unit-'));
// ONE bundle for everything: each bundle has its own copy of the settings cache, and the test must clear the one the handler reads.
const root = process.cwd();
writeFileSync(join(dir, 'entry.ts'), [
  `export * as posts from '${root}/functions/api/posts/index.ts';`,
  `export * as session from '${root}/functions/api/lib/session.ts';`,
  `export * as settings from '${root}/functions/api/lib/settings.ts';`,
  `export * as create from '${root}/functions/api/posts/create.ts';`,
  `export * as cancel from '${root}/functions/api/posts/cancel.ts';`,
  `export * as refund from '${root}/functions/api/lib/overagerefund.ts';`,
  `export * as overage from '${root}/functions/api/usage/overage.ts';`,
].join('\n'));
await build({ entryPoints: [join(dir, 'entry.ts')], bundle: true, format: 'esm', platform: 'node', outfile: join(dir, 'all.mjs'), logLevel: 'silent' });
const { posts, session, settings, create, cancel, refund, overage } = await import(pathToFileURL(join(dir, 'all.mjs')).href);
rmSync(dir, { recursive: true, force: true });

let passed = 0;
const failed = [];
const check = (name, cond, extra = '') => { if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed.push(name); console.log(`  ✗ ${name} ${extra}`); } };

const CH = '11111111-1111-4111-8111-111111111111';
// getSettings() remembers its answer for 15 s; saveSettings() clears that memory, so every scenario starts with its own switch
async function fresh(opts = {}) {
  const f = build_(opts);
  await settings.saveSettings(f.env, { enforce_limits: opts.enforce ?? true });
  return f;
}
function build_({ plan = 'free', enforce = true, overage: ov = 0, used = {}, cap = null } = {}) {
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
  db.exec(`INSERT INTO users (id, email) VALUES ('u1', 'a@example.com')`);
  db.prepare(`INSERT INTO subscriptions (user_id, plan, overage_enabled, overage_cap_micro_usd) VALUES ('u1', ?, ?, COALESCE(?, 20000000))`).run(plan, ov, cap);
  db.exec(`INSERT INTO channels (id, user_id, type, name, credentials) VALUES ('${CH}', 'u1', 'telegram', 'VaneNews', 'x')`);
  const period = plan === 'free' ? 'lifetime' : new Date().toISOString().slice(0, 7);
  if (used.api || used.ui) db.prepare(`INSERT INTO usage_counters (user_id, period, api_posts, ui_posts) VALUES ('u1', ?, ?, ?)`).run(period, used.api ?? 0, used.ui ?? 0);
  return { db, env, period };
}
const counters = (db) => db.prepare(`SELECT api_posts a, ui_posts u, overage_posts op, overage_micro_usd om FROM usage_counters WHERE user_id = 'u1'`).get() ?? { a: 0, u: 0, op: 0, om: 0 };

let token;
async function post(env, n = 1) {
  token ??= await session.createSession(env, new Request('https://vaneapp.dev/'), 'u1');
  const t = await session.createSession(env, new Request('https://vaneapp.dev/'), 'u1');
  const req = new Request('https://vaneapp.dev/api/posts', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `${session.SESSION_COOKIE ?? 'vane_session'}=${t}`, origin: 'https://vaneapp.dev', 'sec-fetch-site': 'same-origin', 'cf-connecting-ip': '203.0.113.9' },
    body: JSON.stringify({ content: `post ${n}`, channelIds: [CH], scheduledAt: new Date(Date.now() + 3600_000).toISOString() }),
  });
  const res = await posts.onRequestPost({ request: req, env, params: {}, waitUntil() {} });
  let data = null; try { data = await res.json(); } catch { /* */ }
  return { status: res.status, data };
}

const rows = (db) => db.prepare(`SELECT source, units, overage, cost_micro_usd c, refunded_at r FROM usage_logs WHERE user_id = 'u1' AND kind = 'post'`).all();
const NOW = () => Math.floor(Date.now() / 1000);

console.log('\nThe ceiling: $0.03 left of it on Pro at $0.015 an extra post');
{
  const { db, env } = await fresh({ plan: 'pro', overage: 1, used: { ui: 1000 }, cap: 30000 });
  const a = await post(env, 1), b = await post(env, 2), c = await post(env, 3);
  check('two extra posts fit', a.status === 201 && b.status === 201, JSON.stringify([a, b]));
  check('the third is refused: 402 overage_cap_reached', c.status === 402 && c.data.code === 'overage_cap_reached', JSON.stringify(c));
  check('the message names the limit', /\$0\.03/.test(c.data.error), c.data?.error);
  check('the refused post was not saved or counted', db.prepare('SELECT COUNT(*) n FROM posts').get().n === 2 && counters(db).u === 1002 && counters(db).om === 30000, JSON.stringify(counters(db)));
  check('the answer carries the ceiling', c.data.usage?.overage?.capUsd === 0.03 && c.data.usage.overage.spentUsd === 0.03, JSON.stringify(c.data.usage?.overage));
}
{
  const { db, env } = await fresh({ plan: 'pro', overage: 1, used: { ui: 1000 }, cap: 15000 });
  const results = await Promise.all([1, 2, 3, 4].map((n) => post(env, n)));
  check('four parallel extra posts for one unit of room: exactly one gets in', results.filter((r) => r.status === 201).length === 1 && counters(db).om === 15000, JSON.stringify(results.map((r) => r.status)));
}
{
  const { db, env } = await fresh({ plan: 'pro', overage: 1, used: { ui: 1000 } });
  check('a new account has the $20 default', db.prepare(`SELECT overage_cap_micro_usd v FROM subscriptions WHERE user_id = 'u1'`).get().v === 20_000_000);
  check('posts inside the quota are never stopped by it', (await post(env)).status === 201);
}
{
  const { db, env } = await fresh({ plan: 'pro', overage: 1, used: { ui: 5 }, cap: 1000 });
  check('a ceiling below one extra post does not stop posts inside the quota', (await post(env)).status === 201 && counters(db).om === 0);
}

console.log('\nThe setting: POST /api/usage/overage');
{
  const { db, env } = await fresh({ plan: 'pro', overage: 1 });
  const t = await session.createSession(env, new Request('https://vaneapp.dev/'), 'u1');
  const call = async (body) => {
    const res = await overage.onRequestPost({ request: new Request('https://vaneapp.dev/api/usage/overage', { method: 'POST', headers: { 'content-type': 'application/json', cookie: `vane_session=${t}`, origin: 'https://vaneapp.dev', 'sec-fetch-site': 'same-origin' }, body: JSON.stringify(body) }), env, params: {}, waitUntil() {} });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  const r = await call({ capUsd: 50 });
  check('capUsd alone sets the ceiling and keeps the switch', r.status === 200 && r.data.overage.capUsd === 50 && r.data.overage.enabled === true, JSON.stringify(r));
  check('0.5, 1001, text and nothing are refused', (await call({ capUsd: 0.5 })).status === 400 && (await call({ capUsd: 1001 })).status === 400 && (await call({ capUsd: '5' })).status === 400 && (await call({})).status === 400);
  const off = await call({ enabled: false });
  check('switching off keeps the ceiling', off.status === 200 && off.data.overage.capUsd === 50 && off.data.overage.enabled === false, JSON.stringify(off));
}

console.log('\nRefund: an extra post that delivered nothing');
async function extraPost(env, n) { const r = await post(env, n); return r.data.posts[0].id; }
{
  const { db, env } = await fresh({ plan: 'pro', overage: 1, used: { ui: 1000 } });
  const id = await extraPost(env, 1);
  check('an extra dashboard post leaves an audit row', rows(db).length === 1 && rows(db)[0].source === 'ui' && rows(db)[0].c === 15000, JSON.stringify(rows(db)));
  const res = await cancel.cancelPostForUser(env, 'u1', id);
  check('cancelled: the post is cancelled', res.status === 200);
  const c = counters(db);
  check('and the charge is given back (unit, count and money)', c.u === 1000 && c.op === 0 && c.om === 0, JSON.stringify(c));
  check('the audit row is marked refunded', rows(db)[0].r > 0);
  check('a second sweep gives nothing back twice', (await refund.refundIdleOverage(env.DB, NOW())) === 0 && counters(db).u === 1000);
}
{
  const { db, env } = await fresh({ plan: 'pro', overage: 1, used: { ui: 1000 } });
  const id = await extraPost(env, 1);
  db.prepare(`UPDATE posts SET status = 'failed', error = 'The channel is disabled.' WHERE id = ?`).run(id);
  check('failed (nothing delivered): refunded by the sweep', (await refund.refundIdleOverage(env.DB, NOW())) === 1 && counters(db).om === 0 && counters(db).u === 1000);
}
{
  const { db, env } = await fresh({ plan: 'pro', overage: 1, used: { ui: 1000 } });
  const id = await extraPost(env, 1);
  db.prepare(`UPDATE posts SET status = 'failed', error = 'Delivery was interrupted and could not be confirmed. Check the channel; reschedule if the post is missing.' WHERE id = ?`).run(id);
  check('"delivery was interrupted" may have been delivered: NOT refunded', (await refund.refundIdleOverage(env.DB, NOW())) === 0 && counters(db).om === 15000);
}
{
  const { db, env } = await fresh({ plan: 'pro', overage: 1, used: { ui: 1000 } });
  const id = await extraPost(env, 1);
  db.prepare(`UPDATE posts SET status = 'sent' WHERE id = ?`).run(id);
  check('sent: not refunded', (await refund.refundIdleOverage(env.DB, NOW())) === 0 && counters(db).om === 15000);
}
{
  const { db, env } = await fresh({ plan: 'pro', overage: 1, used: { ui: 1000 } });
  const id = await extraPost(env, 1);
  db.prepare(`INSERT INTO channels (id, user_id, type, name, credentials) VALUES ('22222222-2222-4222-8222-222222222222', 'u1', 'telegram', 'Two', 'x')`).run();
  const g = db.prepare('SELECT group_id g FROM posts WHERE id = ?').get(id).g;
  db.prepare(`INSERT INTO posts (id, group_id, user_id, channel_id, content, media_keys, scheduled_at, status) VALUES ('33333333-3333-4333-8333-333333333333', ?, 'u1', '22222222-2222-4222-8222-222222222222', 'x', '[]', ?, 'sent')`).run(g, NOW());
  await cancel.cancelPostForUser(env, 'u1', id);
  check('one channel cancelled, another delivered: the request was used, no refund', counters(db).om === 15000 && rows(db)[0].r === null, JSON.stringify([counters(db), rows(db)]));
}
{
  const { db, env } = await fresh({ plan: 'pro', overage: 1, used: { ui: 5 } });
  const id = await extraPost(env, 1);
  await cancel.cancelPostForUser(env, 'u1', id);
  check('a post inside the quota has no charge: cancelling changes nothing', counters(db).u === 6 && rows(db).length === 0);
}

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
