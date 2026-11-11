#!/usr/bin/env node
/**
 * The activity calendar: GET /api/posts/activity (real handler, real schema.sql in memory) and the calendar maths of
 * public/assets/heatmap.js (grid, shades, streaks, month labels).   npm run test:unit
 */
import { build } from 'esbuild';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

const dir = mkdtempSync(join(tmpdir(), 'vane-unit-'));
const root = process.cwd();
writeFileSync(join(dir, 'entry.ts'), [
  `export * as activity from '${root}/functions/api/posts/activity.ts';`,
  `export * as session from '${root}/functions/api/lib/session.ts';`,
].join('\n'));
await build({ entryPoints: [join(dir, 'entry.ts')], bundle: true, format: 'esm', platform: 'node', outfile: join(dir, 'all.mjs'), logLevel: 'silent' });
const { activity, session } = await import(pathToFileURL(join(dir, 'all.mjs')).href);
rmSync(dir, { recursive: true, force: true });

let passed = 0;
const failed = [];
const check = (name, cond, extra = '') => { if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed.push(name); console.log(`  ✗ ${name} ${extra}`); } };

const db = new DatabaseSync(':memory:');
db.exec(readFileSync('schema.sql', 'utf8'));
const mk = (sql) => {
  let args = [];
  const st = { bind(...a) { args = a; return st; }, async first() { return db.prepare(sql).get(...args) ?? null; }, async run() { const r = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes) } }; }, async all() { return { results: db.prepare(sql).all(...args) }; } };
  return st;
};
const env = { ENCRYPTION_KEY: 'k'.repeat(40), DB: { prepare: mk, async batch(s) { const o = []; for (const x of s) o.push(await x.run()); return o; } } };
db.exec(`INSERT INTO users (id, email) VALUES ('u1', 'a@example.com'), ('u2', 'b@example.com')`);
db.exec(`INSERT INTO channels (id, user_id, type, name, credentials) VALUES ('c1', 'u1', 'telegram', 'T', 'x'), ('c2', 'u1', 'bluesky', 'B', 'x'), ('c3', 'u2', 'telegram', 'T', 'x')`);
const now = Math.floor(Date.now() / 1000);
let n = 0;
const add = (user, ch, group, status, ts) => db.prepare(`INSERT INTO posts (id, group_id, user_id, channel_id, content, scheduled_at, status, sent_at) VALUES (?, ?, ?, ?, 'x', ?, ?, ?)`).run(`p${++n}`, group, user, ch, ts ?? now, status, status === 'sent' ? ts : null);
const dayStart = Math.floor(now / 86400) * 86400;
add('u1', 'c1', 'g1', 'sent', dayStart + 3600);
add('u1', 'c2', 'g1', 'sent', dayStart + 3700);
add('u1', 'c1', 'g2', 'sent', dayStart + 7200);
add('u1', 'c1', 'g3', 'sent', dayStart - 86400 + 100);
add('u1', 'c1', 'g4', 'failed', dayStart - 2 * 86400 + 100);
add('u1', 'c1', 'g5', 'scheduled', now + 3600);
add('u1', 'c1', 'g6', 'sent', now - 400 * 86400);
add('u2', 'c3', 'g7', 'sent', dayStart + 100);

const token = await session.createSession(env, new Request('https://vaneapp.dev/'), 'u1');
async function get(offset = 0) {
  const req = new Request(`https://vaneapp.dev/api/posts/activity?offset=${offset}`, { headers: { cookie: `${session.SESSION_COOKIE ?? 'vane_session'}=${token}`, 'cf-connecting-ip': '203.0.113.9' } });
  const res = await activity.onRequestGet({ request: req, env, params: {}, waitUntil() {} });
  return { status: res.status, data: await res.json() };
}
const iso = (t) => new Date(t * 1000).toISOString().slice(0, 10);

console.log('\nthe endpoint');
{
  const r = await get();
  check('answers 200', r.status === 200 && r.data.ok);
  check('one publication to two channels counts once, two publications count two', r.data.days[iso(dayStart + 3600)] === 2, JSON.stringify(r.data.days));
  check('yesterday has its one post', r.data.days[iso(dayStart - 86400 + 100)] === 1);
  check('failed, scheduled, older than a year and other people\'s posts are not counted', Object.values(r.data.days).reduce((a, b) => a + b, 0) === 3 && r.data.days[iso(dayStart - 2 * 86400 + 100)] === undefined);
  const east = await get(14 * 60);
  const shifted = Object.keys(east.data.days);
  check('a time zone 14 hours east moves a post sent after 10:00 UTC to the next day', shifted.length >= 1 && east.data.offset === 840);
  check('an absurd offset is ignored', (await get(99999)).data.offset === 0);
  const anon = await activity.onRequestGet({ request: new Request('https://vaneapp.dev/api/posts/activity'), env, params: {}, waitUntil() {} });
  check('without signing in: 401', anon.status === 401);
}

const ctx = { Vane: {}, document: { getElementById: () => null }, window: null, Intl };
ctx.window = ctx;
vm.runInNewContext(readFileSync('public/assets/heatmap.js', 'utf8'), ctx);
const h = ctx.Vane.heatmap;
const today = new Date(2026, 10, 10);
const key = (y, m, d) => h.key(new Date(y, m, d));

console.log('\nthe calendar');
{
  const g = h.build({ [key(2026, 10, 10)]: 3, [key(2026, 10, 9)]: 1 }, today);
  check('53 weeks of 7 days', g.columns.length === 53 && g.columns.every((c) => c.length === 7));
  check('weeks start on Monday', g.columns.every((c) => c[0].date.getDay() === 1));
  check('today (Tuesday 10 Nov 2026) is in the last column, the days after it are blank', g.columns[52][1].key === '2026-11-10' && g.columns[52][2].future && !g.columns[52][1].future);
  check('the total and the busiest day', g.total === 4 && g.max === 3);
  check('shades: none, and four steps up to the busiest day', h.level(0, 3) === 0 && h.level(1, 3) === 2 && h.level(3, 3) === 4 && h.level(1, 100) === 1 && h.level(5, 0) === 0);
  const m = h.months(g.columns);
  check('month labels run in order and do not crowd each other', m.length >= 12 && m.length <= 13 && m.every((x, i) => i === 0 || x.at - m[i - 1].at >= 3), JSON.stringify(m));
}
console.log('\nthe streak');
{
  const days = {};
  for (let i = 0; i < 5; i++) days[h.key(new Date(2026, 10, 10 - i))] = 1;
  check('five days up to today', h.streaks(days, today).current === 5 && h.streaks(days, today).best === 5);
  delete days[h.key(today)];
  check('today still empty: the run counts up to yesterday', h.streaks(days, today).current === 4);
  days[h.key(new Date(2026, 10, 4))] = 0;
  const d2 = { [h.key(new Date(2026, 9, 1))]: 1, [h.key(new Date(2026, 9, 2))]: 1, [h.key(new Date(2026, 9, 3))]: 1, [h.key(new Date(2026, 10, 9))]: 1 };
  check('an older longer run is the best, the current one is separate', h.streaks(d2, today).best === 3 && h.streaks(d2, today).current === 1);
  check('no posts: zero', h.streaks({}, today).current === 0 && h.streaks({}, today).best === 0);
  const gap = { [h.key(new Date(2026, 10, 7))]: 1 };
  check('a gap of two days ends the run', h.streaks(gap, today).current === 0);
}

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
