#!/usr/bin/env node
/**
 * Dashboard post quota (the part that used to be "counted, not blocked"), on the REAL handler POST /api/posts and the REAL schema.sql
 * (in-memory SQLite): the Free Trial's one shared total of 30, Pro's 1,000 a month and what happens over it, atomic reserving,
 * the "enforce_limits" switch, and that nothing changes while that switch is off.   npm run test:unit
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
].join('\n'));
await build({ entryPoints: [join(dir, 'entry.ts')], bundle: true, format: 'esm', platform: 'node', outfile: join(dir, 'all.mjs'), logLevel: 'silent' });
const { posts, session, settings, create } = await import(pathToFileURL(join(dir, 'all.mjs')).href);
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
function build_({ plan = 'free', enforce = true, overage = 0, used = {} } = {}) {
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
  db.prepare(`INSERT INTO subscriptions (user_id, plan, overage_enabled) VALUES ('u1', ?, ?)`).run(plan, overage);
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

console.log('\nFree Trial: one total of 30 posts, shared with the API');
{
  const { db, env } = await fresh({ plan: 'free', used: { api: 10, ui: 19 } });
  const a = await post(env, 1);
  check('the 30th post (29 used) goes through', a.status === 201, JSON.stringify(a));
  check('and is counted', counters(db).u === 20 && counters(db).a === 10);
  const b = await post(env, 2);
  check('the 31st is refused with 402 quota_exceeded', b.status === 402 && b.data.code === 'quota_exceeded', JSON.stringify(b));
  check('the message names the Free Trial and the limit', /Free Trial/.test(b.data.error) && /30/.test(b.data.error), b.data?.error);
  check('the answer carries the usage', b.data.usage?.ui?.limit === 30 && b.data.usage.ui.remaining === 0, JSON.stringify(b.data.usage));
  check('nothing was saved and nothing was counted for the refused post', db.prepare(`SELECT COUNT(*) n FROM posts`).get().n === 1 && counters(db).u === 20);
}
{
  const { db, env } = await fresh({ plan: 'free', used: { api: 30, ui: 0 } });
  check('API posts use the same total: with the API at 30 the dashboard is stopped too', (await post(env)).status === 402);
}
{
  const { db, env } = await fresh({ plan: 'free', used: { ui: 28 } });
  const results = await Promise.all([1, 2, 3, 4, 5].map((n) => post(env, n)));
  check('five parallel posts for the last two units: exactly two get in', results.filter((r) => r.status === 201).length === 2 && results.filter((r) => r.status === 402).length === 3, JSON.stringify(results.map((r) => r.status)));
  check('the total stops at exactly 30', counters(db).u === 30);
}

console.log('\nPro: 1,000 dashboard posts a month');
{
  const { db, env } = await fresh({ plan: 'pro', overage: 0, used: { ui: 1000 } });
  const r = await post(env);
  check('over the quota with overage billing OFF: 402', r.status === 402 && r.data.code === 'quota_exceeded' && /dashboard posts/.test(r.data.error), JSON.stringify(r));
}
{
  const { db, env } = await fresh({ plan: 'pro', overage: 1, used: { ui: 1000 } });
  const r = await post(env);
  check('over the quota with overage billing ON: the post goes through', r.status === 201, JSON.stringify(r));
  const c = counters(db);
  check('and is priced at the plan rate ($0.015) like an API post', c.u === 1001 && c.op === 1 && c.om === 15000, JSON.stringify(c));
}
{
  const { db, env } = await fresh({ plan: 'pro', used: { ui: 5 } });
  const r = await post(env);
  check('within the quota nothing is priced', r.status === 201 && counters(db).u === 6 && counters(db).op === 0 && counters(db).om === 0);
}

console.log('\nA plan with no dashboard allowance (Developer API) is never stopped here');
{
  const { db, env } = await fresh({ plan: 'api', used: { api: 50 } });
  const r = await post(env);
  check('the post goes through and is counted', r.status === 201 && counters(db).u === 1 && counters(db).a === 50, JSON.stringify([r.status, counters(db)]));
}

console.log('\nThe "enforce_limits" switch');
{
  const { db, env } = await fresh({ plan: 'free', enforce: false, used: { ui: 30 } });
  const r = await post(env);
  check('OFF (the default): nothing changes, a Free Trial account over 30 still posts', r.status === 201, JSON.stringify(r));
  check('and the post is still counted, as before', counters(db).u === 31);
}

console.log('\nWhen saving fails after the quota was taken');
{
  const { db, env } = await fresh({ plan: 'free', used: { ui: 3 } });
  const real = env.DB.batch;
  env.DB.batch = async () => { throw new Error('D1 is down'); };
  let status = 0; try { status = (await post(env)).status; } catch { status = 500; }
  env.DB.batch = real;
  check('the unit is given back (not lost)', counters(db).u === 3, JSON.stringify(counters(db)));
}

console.log('\nTolerance: the usage tables are missing');
{
  const { db, env } = await fresh({ plan: 'free' });
  db.exec('DROP TABLE usage_counters');
  const r = await post(env);
  check('posting still works (counting must never be the reason a post fails)', r.status === 201, JSON.stringify(r));
}

console.log('\nThe helper every dashboard-side poster uses (the dashboard and "announce this video")');
{
  const { db, env } = await fresh({ plan: 'free', used: { ui: 29 } });
  const q1 = await create.takeUiQuota(env, 'u1', 1);
  check('the last unit is taken', q1.ok === true && q1.reservation?.counted === true && counters(db).u === 30);
  const q2 = await create.takeUiQuota(env, 'u1', 1);
  check('the next one is refused with a ready 402 answer', q2.ok === false && q2.response.status === 402 && (await q2.response.json()).code === 'quota_exceeded');
  await create.settleUiQuota(env, 'u1', q1.reservation, 1, false);
  check('a post that could not be saved gives its unit back', counters(db).u === 29);
  const q3 = await create.takeUiQuota(env, 'u1', 1);
  await create.settleUiQuota(env, 'u1', q3.reservation, 1, true);
  check('a saved post keeps it, and nothing is counted twice', counters(db).u === 30);
}
{
  const { db, env } = await fresh({ plan: 'free', enforce: false, used: { ui: 5 } });
  const q = await create.takeUiQuota(env, 'u1', 1);
  check('with the limits off nothing is reserved…', q.ok && q.reservation === null && counters(db).u === 5);
  await create.settleUiQuota(env, 'u1', q.reservation, 1, true);
  check('…the saved post is just counted', counters(db).u === 6);
  const q2 = await create.takeUiQuota(env, 'u1', 1);
  await create.settleUiQuota(env, 'u1', q2.reservation, 1, false);
  check('…and an unsaved one is not counted', counters(db).u === 6);
}

console.log('\nNo way around the quota (source check)');
{
  const files = [];
  const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.ts')) files.push(p); } };
  walk('functions'); walk('worker');
  const posters = files.filter((f) => /\binsertPostGroup\(/.test(readFileSync(f, 'utf8')));   // create.ts defines and uses it; the API and video announcements call it
  const unguarded = posters.filter((f) => { const t = readFileSync(f, 'utf8'); return !/\btakeUiQuota\(/.test(t) && !/\breserveApiPost\(/.test(t); });
  check(`every file that creates posts takes a quota first (${posters.length} found)`, posters.length >= 3 && unguarded.length === 0, unguarded.join(', '));
}

console.log('\nEvery JSON answer says nosniff');
{
  const { env } = await fresh({ plan: 'free', used: { ui: 30 } });
  const req = new Request('https://vaneapp.dev/api/posts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const res = await posts.onRequestPost({ request: req, env, params: {}, waitUntil() {} });
  check('a 401 from the API has X-Content-Type-Options: nosniff', res.status === 401 && res.headers.get('x-content-type-options') === 'nosniff');
}

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
