#!/usr/bin/env node
/**
 * The composer's "Best time" button: GET /api/posts/best-times (functions/api/posts/best-times.ts) on the REAL code and the REAL
 * schema.sql (in-memory SQLite). Paid plans only; the slots come from the person's own results (or defaults), skip times that
 * already have a post and never use another account's data.   npm run test:unit
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
  `export * as route from '${root}/functions/api/posts/best-times.ts';`,
  `export * as session from '${root}/functions/api/lib/session.ts';`,
  `export * as plans from '${root}/functions/api/lib/plans.ts';`,
].join('\n'));
await build({ entryPoints: [join(dir, 'entry.ts')], bundle: true, format: 'esm', platform: 'node', outfile: join(dir, 'all.mjs'), logLevel: 'silent' });
const { route, session, plans } = await import(pathToFileURL(join(dir, 'all.mjs')).href);
rmSync(dir, { recursive: true, force: true });

let passed = 0;
const failed = [];
const check = (name, cond, extra = '') => { if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed.push(name); console.log(`  ✗ ${name} ${extra}`); } };
const NOW = Math.floor(Date.now() / 1000), DAY = 86400;
let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

function make({ plan = 'pro', tz = 'UTC' } = {}) {
  plans.invalidatePlanSpecs();
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(readFileSync('schema.sql', 'utf8'));
  const mk = (sql) => ({
    bind(...a) { const c = mk(sql); c.args = a; return c; },
    async first() { return db.prepare(sql).get(...(this.args ?? [])) ?? null; },
    async run() { const r = db.prepare(sql).run(...(this.args ?? [])); return { success: true, meta: { changes: Number(r.changes) } }; },
    async all() { return { results: db.prepare(sql).all(...(this.args ?? [])) }; },
    args: [],
  });
  const env = { ENCRYPTION_KEY: 'k'.repeat(40), DB: { prepare: mk, async batch(stmts) { const out = []; for (const s of stmts) out.push(await s.run()); return out; } } };
  db.exec(`INSERT INTO users (id, email, timezone) VALUES ('u1', 'a@example.com', '${tz}'), ('u2', 'b@example.com', 'UTC')`);
  db.exec(`INSERT INTO subscriptions (user_id, plan, status) VALUES ('u1', '${plan}', 'active'), ('u2', 'pro', 'active')`);
  db.exec(`INSERT INTO channels (id, user_id, type, name, credentials) VALUES ('c1', 'u1', 'telegram', 'News', 'x'), ('c2', 'u2', 'telegram', 'Other', 'x')`);
  return { db, env };
}
/** A sent post with results, `daysAgo` days ago at `hour`:30 UTC. */
function sentAt(db, { user = 'u1', ch = 'c1', weekdayOf, hour, likes }) {
  // the latest date before now that falls on `weekdayOf` (0 = Sunday … 6 = Saturday), at hour:30 UTC
  const d = new Date((NOW - 3 * DAY) * 1000); d.setUTCHours(hour, 30, 0, 0);
  while (d.getUTCDay() !== weekdayOf) d.setUTCDate(d.getUTCDate() - 1);
  d.setUTCDate(d.getUTCDate() - 7 * (seq % 5));          // spread over a few weeks
  const at = Math.floor(d.getTime() / 1000), id = uuid();
  db.prepare(`INSERT INTO posts (id, group_id, user_id, channel_id, content, media_keys, scheduled_at, status, external_id, sent_at) VALUES (?, ?, ?, ?, 'hello', '[]', ?, 'sent', 'e', ?)`).run(id, id, user, ch, at, at);
  db.prepare(`INSERT INTO post_metrics (post_id, stage, taken_at, views, likes, replies, reposts) VALUES (?, 3, ?, 0, ?, 0, 0)`).run(id, at + 100, likes);
}
async function get(env, query = '', { user = 'u1', cookie = true, method = 'GET' } = {}) {
  const headers = { 'cf-connecting-ip': '203.0.113.9' };
  if (cookie) headers.cookie = `vane_session=${await session.createSession(env, new Request('https://vaneapp.dev/'), user)}`;
  const res = await (method === 'GET' ? route.onRequestGet : route.onRequest)({ request: new Request(`https://vaneapp.dev/api/posts/best-times${query}`, { method, headers }), env, params: {}, waitUntil() {} });
  let data = null; try { data = await res.clone().json(); } catch { /* not JSON */ }
  return { status: res.status, data, headers: res.headers };
}
const localHour = (at, tz) => Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(new Date(at * 1000)));
const localDay = (at, tz) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(new Date(at * 1000)));

console.log('\nwho may use it');
{
  const { env } = make();
  check('not signed in: 401', (await get(env, '', { cookie: false })).status === 401);
  check('other methods: 405', (await get(env, '', { method: 'POST' })).status === 405);
  const free = make({ plan: 'free' });
  const r = await get(free.env);
  check('Free Trial: 402 paid_plan_required, no slots', r.status === 402 && r.data.code === 'paid_plan_required' && !r.data.slots, JSON.stringify(r.data));
  const paid = await get(env);
  check('a paid account gets slots', paid.status === 200 && paid.data.ok === true && Array.isArray(paid.data.slots));
}

console.log('\nwithout results: honest defaults');
{
  const { env } = make();
  const r = await get(env);
  const s = r.data.slots;
  check('three slots by default, soonest first', s.length === 3 && s[0] < s[1] && s[1] < s[2], JSON.stringify(s));
  check('it says they are defaults, not personal', r.data.personal === false);
  check('every slot is in the future', s.every((t) => t > NOW + 600));
  check('the defaults are morning, midday and evening in the account time zone', JSON.stringify(s.map((t) => localHour(t, 'UTC'))) === '[9,13,18]', JSON.stringify(s.map((t) => localHour(t, 'UTC'))));
  check('the time zone is reported', r.data.timeZone === 'UTC');
}

console.log('\ntime zone and count');
{
  const { env } = make({ tz: 'America/New_York' });
  const stored = await get(env);
  check('no tz sent: the saved time zone of the account', stored.data.timeZone === 'America/New_York' && stored.data.slots.every((t, i) => localHour(t, 'America/New_York') === [9, 13, 18][i]));
  const sent = await get(env, '?tz=Europe/Kyiv');
  check('the browser time zone wins', sent.data.timeZone === 'Europe/Kyiv' && sent.data.slots.every((t, i) => localHour(t, 'Europe/Kyiv') === [9, 13, 18][i]));
  const bad = await get(env, '?tz=Not/AZone');
  check('a wrong time zone is ignored, not an error', bad.status === 200 && bad.data.timeZone === 'America/New_York');
  const junk = await get(env, `?tz=${encodeURIComponent('x'.repeat(500))}`);
  check('an absurd time zone value is ignored too', junk.status === 200 && junk.data.timeZone === 'America/New_York');
  check('count=2 → two slots', (await get(env, '?count=2')).data.slots.length === 2);
  check('count above the cap → 5', (await get(env, '?count=99')).data.slots.length === 5);
  check('count=0 → at least one slot, never zero or an error', (await get(env, '?count=0')).data.slots.length === 1);
  check('count that is not a number → 3', (await get(env, '?count=abc')).data.slots.length === 3);
}

console.log('\nwith results: the person\'s own best hours');
{
  const { db, env } = make();
  for (let i = 0; i < 6; i++) sentAt(db, { weekdayOf: 3, hour: 10, likes: 20 });   // Wednesdays 09–12: great
  for (let i = 0; i < 3; i++) sentAt(db, { weekdayOf: 1, hour: 19, likes: 4 });    // Mondays 18–21: weaker
  const r = await get(env, '?count=5');
  check('it is personal now', r.data.personal === true);
  check('every slot is on the hour the data points to: 10:00, or 19:00 on a Monday', r.data.slots.every((t) => localHour(t, 'UTC') === (localDay(t, 'UTC') === 1 ? 19 : 10)), JSON.stringify(r.data.slots.map((t) => [localDay(t, 'UTC'), localHour(t, 'UTC')])));
  check('on the minute: :00', r.data.slots.every((t) => t % 3600 === 0));
}
{
  const { db, env } = make();
  for (let i = 0; i < 6; i++) sentAt(db, { user: 'u2', ch: 'c2', weekdayOf: 3, hour: 10, likes: 30 });   // only ANOTHER account has data
  const r = await get(env);
  check('another account\'s results are never used', r.data.personal === false && r.data.slots.every((t, i) => localHour(t, 'UTC') === [9, 13, 18][i]));
}

console.log('\nfree times only');
{
  const { db, env } = make();
  const first = (await get(env)).data.slots;
  const id = uuid();
  db.prepare(`INSERT INTO posts (id, group_id, user_id, channel_id, content, media_keys, scheduled_at, status) VALUES (?, ?, 'u1', 'c1', 'queued', '[]', ?, 'scheduled')`).run(id, id, first[0]);
  const again = (await get(env)).data.slots;
  check('a time that already has a scheduled post is not offered again', again.every((t) => Math.abs(t - first[0]) >= 3600), JSON.stringify([first, again]));
  check('still three slots', again.length === 3);
}

console.log('\nrate limit');
{
  const { env } = make();
  let last;
  for (let i = 0; i < 121; i++) last = await get(env);
  check('the 121st request in an hour: 429 with Retry-After', last.status === 429 && Number(last.headers.get('retry-after')) > 0, String(last.status));
  const other = make();
  check('another account is not affected', (await get(other.env)).status === 200);
}

console.log(`\n${passed} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
