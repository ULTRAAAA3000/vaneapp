#!/usr/bin/env node
/**
 * Analytics v3: the Activity tab (every network, own data only), the comparison with the previous period, the Formats analysis, the growth of one post
 * and the new CSV kinds, on the REAL code and the REAL schema.sql (in-memory SQLite). Free must get the basics, Pro the rest, and nobody another
 * user's rows.   npm run test:unit
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
  `export * as act from '${root}/functions/api/lib/analyticsactivity.ts';`,
  `export * as query from '${root}/functions/api/lib/analyticsquery.ts';`,
  `export * as overview from '${root}/functions/api/analytics/overview.ts';`,
  `export * as insights from '${root}/functions/api/analytics/insights.ts';`,
  `export * as activity from '${root}/functions/api/analytics/activity.ts';`,
  `export * as postRoute from '${root}/functions/api/analytics/post.ts';`,
  `export * as exportRoute from '${root}/functions/api/analytics/export.ts';`,
  `export * as session from '${root}/functions/api/lib/session.ts';`,
].join('\n'));
await build({ entryPoints: [join(dir, 'entry.ts')], bundle: true, format: 'esm', platform: 'node', outfile: join(dir, 'all.mjs'), logLevel: 'silent' });
const { act, query, overview, insights, activity, postRoute, exportRoute, session } = await import(pathToFileURL(join(dir, 'all.mjs')).href);
rmSync(dir, { recursive: true, force: true });

let passed = 0;
const failed = [];
const check = (name, cond, extra = '') => { if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed.push(name); console.log(`  ✗ ${name} ${extra}`); } };

const TG = '11111111-1111-4111-8111-111111111111';
const LI = '22222222-2222-4222-8222-222222222222';
const BS = '33333333-3333-4333-8333-333333333333';
const FOREIGN = '44444444-4444-4444-8444-444444444444';
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;
const ago = (days, extra = 0) => NOW - Math.round(days * DAY) - extra;

let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

function make({ pro = false } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(readFileSync('schema.sql', 'utf8'));
  const mk = (sql) => {
    const args = [];
    const st = {
      bind(...a) { const c = mk(sql); c.args = a; return c; },
      async first() { return db.prepare(sql).get(...this.args) ?? null; },
      async run() { const r = db.prepare(sql).run(...this.args); return { success: true, meta: { changes: Number(r.changes) } }; },
      async all() { return { results: db.prepare(sql).all(...this.args) }; },
      args,
    };
    return st;
  };
  const env = { ENCRYPTION_KEY: 'k'.repeat(40), DB: { prepare: mk, async batch(stmts) { const out = []; for (const s of stmts) out.push(await s.run()); return out; } } };
  db.exec(`INSERT INTO users (id, email, timezone) VALUES ('u1', 'a@example.com', 'UTC'), ('u2', 'b@example.com', 'UTC')`);
  db.exec(`INSERT INTO subscriptions (user_id, plan) VALUES ('u1', 'free')`);
  if (pro) db.exec(`INSERT INTO analytics_subscriptions (user_id, status, current_period_end) VALUES ('u1', 'active', NULL)`);
  db.exec(`INSERT INTO channels (id, user_id, type, name, credentials) VALUES
    ('${TG}', 'u1', 'telegram', 'News', 'x'), ('${LI}', 'u1', 'linkedin', 'Company', 'x'), ('${BS}', 'u1', 'bluesky', 'me.bsky.social', 'x'), ('${FOREIGN}', 'u2', 'telegram', 'Other', 'x')`);
  return { db, env };
}

/** A post row. status 'sent' gets sent_at (default: right on time); 'failed' keeps no sent_at. */
function put(db, o) {
  const r = { id: uuid(), user: 'u1', ch: TG, content: 'hello', media: '[]', at: ago(1), status: 'sent', delay: 0, error: null, ext: 'ext', ...o };
  db.prepare(`INSERT INTO posts (id, group_id, user_id, channel_id, content, media_keys, scheduled_at, status, external_id, error, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(r.id, r.id, r.user, r.ch, r.content, r.media, r.at, r.status, r.status === 'sent' ? r.ext : null, r.error, r.status === 'sent' ? r.at + r.delay : null);
  return r.id;
}
const metrics = (db, id, stage, likes, replies, reposts, views = null) =>
  db.prepare(`INSERT INTO post_metrics (post_id, stage, taken_at, views, likes, replies, reposts) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, stage, NOW, views, likes, replies, reposts);

async function call(env, handler, { path, user = 'u1' }) {
  const t = await session.createSession(env, new Request('https://vaneapp.dev/'), user);
  const req = new Request(`https://vaneapp.dev${path}`, { method: 'GET', headers: { cookie: `vane_session=${t}`, 'cf-connecting-ip': '203.0.113.9' } });
  const res = await handler({ request: req, env, params: {}, waitUntil() {} });
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch { /* CSV */ }
  return { status: res.status, data, text, headers: res.headers };
}

console.log('\nFailure reasons');
{
  check('links, ids and long numbers are folded away', act.reasonOf('Failed at https://api.x.com/v2/1234567890?a=1 for 8c1f3b2a-1111-4222-8333-444455556666 code 1234567') === 'Failed at <link> for <id> code #');
  check('equal causes get one text', act.reasonOf('Rate limit 429, retry in 3600 s') === act.reasonOf('Rate limit 429, retry in 7200 s'));
  check('an empty or missing reason has a readable text', act.reasonOf(null) === 'No reason was recorded' && act.reasonOf('   ') === 'No reason was recorded');
  check('a long text is cut to 110 characters', act.reasonOf('x'.repeat(500)).length === 110);
}

console.log('\nStreaks');
{
  const iso = (t) => new Date(t * 1000).toISOString().slice(0, 10);
  const d = (n) => ({ day: iso(NOW - n * DAY), sent: 1 });
  const s1 = act.streaks([d(0), d(1), d(2), d(5)], NOW);
  check('three days in a row ending today', s1.current === 3 && s1.longest === 3 && s1.activeDays === 4, JSON.stringify(s1));
  const s2 = act.streaks([d(1), d(2)], NOW);
  check('today still empty: the run that ended yesterday still counts', s2.current === 2, JSON.stringify(s2));
  const s3 = act.streaks([d(3), d(4), d(5), d(6), d(0)], NOW);
  check('an older longer run is the longest, the current one is only today', s3.current === 1 && s3.longest === 4, JSON.stringify(s3));
  check('days with only failures do not count', act.streaks([{ day: iso(NOW), sent: 0 }], NOW).current === 0);
  check('no data', act.streaks([], NOW).current === 0 && act.streaks([], NOW).longest === 0);
}

console.log('\nTraits of a post');
{
  const t = query.formatTraits('Why do we ship on Friday? #dev #ship #fun https://x.dev/a', '["k1"]');
  check('media, question, link and 3 hashtags are seen', t.media === 'With media' && t.question === 'Asks a question' && t.link === 'With a link' && t.hashtags === '3 or more hashtags', JSON.stringify(t));
  const u = query.formatTraits('plain', '[]');
  check('a plain post', u.media === 'Text only' && u.question === 'No question' && u.link === 'No link' && u.hashtags === 'No hashtags' && u.length.startsWith('Short'));
  check('a broken media value counts as no media', query.formatTraits('a', 'not json').media === 'Text only');
  check('length buckets', query.formatTraits('a'.repeat(79), '[]').length.startsWith('Short') && query.formatTraits('a'.repeat(80), '[]').length.startsWith('Medium') && query.formatTraits('a'.repeat(200), '[]').length.startsWith('Long'));
  check('a # inside a word is not a hashtag', query.formatTraits('issue#12 and c#', '[]').hashtags === 'No hashtags');
  check('hashtags in other alphabets count', query.formatTraits('привіт #новини #київ', '[]').hashtags === '1–2 hashtags');
}

console.log('\nActivity: counts on the real tables');
{
  const { db, env } = make();
  put(db, { ch: TG, at: ago(1) }); put(db, { ch: TG, at: ago(2), media: '["a"]', content: 'x'.repeat(100) });
  put(db, { ch: LI, at: ago(2) });
  put(db, { ch: LI, at: ago(3), status: 'failed', error: 'LinkedIn said 401 for https://api.linkedin.com/x' });
  put(db, { ch: LI, at: ago(4), status: 'failed', error: 'LinkedIn said 401 for https://api.linkedin.com/y' });
  put(db, { ch: TG, at: ago(5), status: 'failed', error: null });
  put(db, { ch: TG, at: NOW + 3600, status: 'scheduled' });
  put(db, { ch: TG, at: ago(1), status: 'cancelled' });
  put(db, { ch: FOREIGN, user: 'u2', at: ago(1) });
  const f = { userId: 'u1', since: ago(30), until: NOW + 1, channels: [TG, LI] };
  const t = await act.activityTotals(env, f);
  check('sent, failed and media are counted; cancelled and scheduled are not', t.sent === 3 && t.failed === 3 && t.media === 1, JSON.stringify(t));
  check('the average length of sent posts', t.avgLen === Math.round((5 + 100 + 5) / 3), String(t.avgLen));
  check('even if a foreign channel id slips into the list, the user filter keeps its posts out', (await act.activityTotals(env, { ...f, channels: [TG, FOREIGN] })).sent === 2);
  check('only the chosen channels are counted', (await act.activityTotals(env, { ...f, channels: [LI] })).sent === 1);
  check('no channel chosen → nothing, not everything', (await act.activityTotals(env, { ...f, channels: [] })).sent === 0);
  check('upcoming = waiting posts on the chosen channels', (await act.activityUpcoming(env, 'u1', [TG, LI])) === 1 && (await act.activityUpcoming(env, 'u1', [LI])) === 0 && (await act.activityUpcoming(env, 'u1', [])) === 0);
  const daily = await act.activityDaily(env, f);
  check('daily rows carry sent and failed per day', daily.reduce((a, r) => a + r.sent, 0) === 3 && daily.reduce((a, r) => a + r.failed, 0) === 3);
  const byCh = await act.activityByChannel(env, f);
  check('per channel, busiest first', byCh[0].channel_id === TG || byCh[0].sent >= byCh[1].sent, JSON.stringify(byCh));
  const fails = await act.activityFailures(env, f);
  check('equal failures are grouped, the most frequent first', fails[0].count === 2 && fails[0].reason.includes('<link>') && fails.length === 2, JSON.stringify(fails));
  check('a failure with no recorded reason has its own line', fails.some((x) => x.reason === 'No reason was recorded' && x.count === 1));
  const old = await act.activityTotals(env, { ...f, since: ago(60), until: ago(30) });
  check('an earlier window sees nothing of this one', old.sent === 0 && old.failed === 0);
}

console.log('\nActivity: punctuality and habits');
{
  const { db, env } = make();
  for (let i = 0; i < 18; i++) put(db, { at: ago(1, i * 60), delay: 5 });
  put(db, { at: ago(2), delay: 600 }); put(db, { at: ago(3), delay: 900 });
  const f = { userId: 'u1', since: ago(30), until: NOW + 1, channels: [TG] };
  const p = await act.activityPunctuality(env, f);
  check('90% went out within two minutes', p.n === 20 && p.onTimePct === 90, JSON.stringify(p));
  check('the slowest 5% is reported', p.p95Sec >= 600, JSON.stringify(p));
  check('an empty window has no invented numbers', (await act.activityPunctuality(env, { ...f, channels: [LI] })).onTimePct === null);
  // 2026-10-14 is a Wednesday: 10:30 UTC is slot 3 (09–12), 23:30 UTC is slot 7 (21–24)
  const wed = Math.floor(Date.parse('2026-10-14T10:30:00Z') / 1000);
  const late = Math.floor(Date.parse('2026-10-14T23:30:00Z') / 1000);
  const h = make();
  put(h.db, { at: wed }); put(h.db, { at: wed + 60 }); put(h.db, { at: late });
  const wide = { userId: 'u1', since: 0, until: NOW + 1, channels: [TG] };
  const utc = await act.activityHabits(h.env, wide, 'UTC');
  check('Wednesday 10:30 UTC lands in Wed, slot 09–12; the late one in Wed 21–24', utc[2][3] === 2 && utc[2][7] === 1, JSON.stringify(utc[2]));
  const tokyo = await act.activityHabits(h.env, wide, 'Asia/Tokyo');
  check('in Tokyo the same posts are 19:30 Wed (slot 18–21) and 08:30 Thu (slot 06–09)', tokyo[2][6] === 2 && tokyo[3][2] === 1, JSON.stringify([tokyo[2], tokyo[3]]));
  check('an unknown time zone falls back to UTC instead of failing', (await act.activityHabits(h.env, wide, 'Mars/Base'))[2][3] === 2);
}

console.log('\nPrevious period and Formats');
{
  const { db, env } = make();
  const a = put(db, { ch: BS, at: ago(2), content: 'Why? #a #b #c', media: '["m"]' }); metrics(db, a, 1, 10, 2, 0);
  const b = put(db, { ch: BS, at: ago(3), content: 'plain text' }); metrics(db, b, 1, 2, 0, 0);
  const c = put(db, { ch: BS, at: ago(4), content: 'another plain one' }); metrics(db, c, 2, 4, 0, 0);
  const old = put(db, { ch: BS, at: ago(40), content: 'old post' }); metrics(db, old, 1, 7, 1, 1, 50);
  const f = { userId: 'u1', since: ago(30), channels: [BS], q: '' };
  const now = await query.queryTotals(env, f);
  const prev = await query.queryTotals(env, { ...f, since: ago(60), until: ago(30) });
  check('this period', now.posts === 3 && now.likes === 16, JSON.stringify(now));
  check('the previous period of the same length', prev.posts === 1 && prev.likes === 7 && prev.views === 50, JSON.stringify(prev));
  check('without `until` nothing changes for the old callers', (await query.queryTotals(env, { ...f, since: ago(60) })).posts === 4);
  const fm = await query.queryFormats(env, f);
  const g = (k) => fm.groups.find((x) => x.key === k);
  check('only posts that already have numbers are compared', fm.n === 3);
  check('media: with media averages 12, text only 3, best first', g('media').rows[0].label === 'With media' && g('media').rows[0].avg === 12 && g('media').rows[1].avg === 3, JSON.stringify(g('media')));
  check('hashtags: 3 or more → 12', g('hashtags').rows.find((r) => r.label === '3 or more hashtags').avg === 12);
  check('a trait nobody used does not show up as an empty row', !g('link') || !g('link').rows.some((r) => r.label === 'With a link'));
}

console.log('\nRoute: GET /api/analytics/activity');
{
  const { db, env } = make();
  put(db, { ch: LI, at: ago(1) }); put(db, { ch: LI, at: ago(2) }); put(db, { ch: TG, at: ago(2) });
  put(db, { ch: LI, at: ago(3), status: 'failed', error: 'expired token' });
  put(db, { ch: FOREIGN, user: 'u2', at: ago(1) });
  const r = await call(env, activity.onRequestGet, { path: '/api/analytics/activity?days=365' });
  check('Free: 200, and the period is capped at 30 days', r.status === 200 && r.data.ok && r.data.pro === false && r.data.days === 30, JSON.stringify(r.data).slice(0, 200));
  check('a network that gives no numbers back (LinkedIn) still has its activity', r.data.byNetwork.find((n) => n.type === 'linkedin')?.sent === 2);
  check('all of the user’s channels are selected by default, never another user’s', r.data.selected.length === 3 && !r.data.selected.includes(FOREIGN));
  check('another user’s post is not counted', r.data.totals.sent === 3 && r.data.totals.failed === 1);
  check('Free gets the comparison, the streak and the upcoming count', r.data.prev && r.data.streak && typeof r.data.upcoming === 'number');
  check('Free does not get the Pro parts', r.data.habits === undefined && r.data.failures === undefined && r.data.punctuality === undefined && r.data.byChannel === undefined);
  const one = await call(env, activity.onRequestGet, { path: `/api/analytics/activity?channels=${TG}` });
  check('one channel can be picked', one.data.selected.length === 1 && one.data.totals.sent === 1);
  const stolen = await call(env, activity.onRequestGet, { path: `/api/analytics/activity?channels=${FOREIGN}` });
  check('asking for someone else’s channel falls back to your own, and leaks nothing', !stolen.data.selected.includes(FOREIGN) && stolen.data.totals.sent === 3);
  check('days below 7 are ignored', (await call(env, activity.onRequestGet, { path: '/api/analytics/activity?days=1' })).data.days === 30);
}
{
  const { db, env } = make({ pro: true });
  put(db, { ch: LI, at: ago(100) }); put(db, { ch: TG, at: ago(2) }); put(db, { ch: TG, at: ago(3), status: 'failed', error: 'boom 4242' });
  const r = await call(env, activity.onRequestGet, { path: '/api/analytics/activity?days=365' });
  check('Pro: 365 days are allowed', r.data.pro === true && r.data.days === 365 && r.data.totals.sent === 2);
  check('Pro: habits are a 7 × 8 grid', r.data.habits.length === 7 && r.data.habits.every((row) => row.length === 8) && r.data.habits.flat().reduce((a, b) => a + b, 0) === 2);
  check('Pro: failure reasons, punctuality and the per-channel table', r.data.failures[0].reason === 'boom #' && r.data.punctuality.n === 2 && r.data.byChannel.length === 2);
  check('Pro: the time zone of the user is reported', r.data.timeZone === 'UTC');
}

console.log('\nRoute: GET /api/analytics/overview (previous period)');
{
  const { db, env } = make();
  const a = put(db, { ch: BS, at: ago(2) }); metrics(db, a, 1, 5, 0, 0);
  const b = put(db, { ch: BS, at: ago(40) }); metrics(db, b, 1, 3, 0, 0);
  const r = await call(env, overview.onRequestGet, { path: `/api/analytics/overview?days=30&channels=${BS}` });
  check('Free gets totals and the previous period', r.status === 200 && r.data.totals.likes === 5 && r.data.prev.likes === 3 && r.data.prev.posts === 1, JSON.stringify(r.data.prev));
}

console.log('\nRoute: GET /api/analytics/insights (Formats)');
{
  const free = make();
  const denied = await call(free.env, insights.onRequestGet, { path: '/api/analytics/insights' });
  check('Free: 402 pro_required', denied.status === 402 && denied.data.code === 'pro_required');
  const { db, env } = make({ pro: true });
  const a = put(db, { ch: BS, at: ago(2), content: 'Why? https://x.dev' }); metrics(db, a, 1, 4, 1, 0);
  const r = await call(env, insights.onRequestGet, { path: `/api/analytics/insights?days=90&channels=${BS}` });
  check('Pro: formats come with compare and best times', r.status === 200 && r.data.formats.n === 1 && r.data.formats.groups.length > 0 && Array.isArray(r.data.compare));
}

console.log('\nRoute: GET /api/analytics/post (growth)');
{
  const free = make();
  const fid = put(free.db, { ch: BS });
  check('Free: 402', (await call(free.env, postRoute.onRequestGet, { path: `/api/analytics/post?id=${fid}` })).status === 402);
  const { db, env } = make({ pro: true });
  const id = put(db, { ch: BS, at: ago(10) });
  metrics(db, id, 2, 8, 1, 0); metrics(db, id, 1, 3, 0, 0); metrics(db, id, 3, 15, 2, 1);
  const other = put(db, { ch: FOREIGN, user: 'u2', at: ago(10) });
  metrics(db, other, 1, 99, 0, 0);
  const r = await call(env, postRoute.onRequestGet, { path: `/api/analytics/post?id=${id}` });
  check('Pro: the snapshots come in order of age', r.status === 200 && r.data.stages.map((s) => s.stage).join() === '1,2,3' && r.data.stages[2].likes === 15, JSON.stringify(r.data));
  check('another user’s post is a plain 404', (await call(env, postRoute.onRequestGet, { path: `/api/analytics/post?id=${other}` })).status === 404);
  check('a bad id is 400', (await call(env, postRoute.onRequestGet, { path: '/api/analytics/post?id=abc' })).status === 400);
  const scheduled = put(db, { ch: BS, status: 'scheduled', at: NOW + 999 });
  check('a post that is not sent yet is 404', (await call(env, postRoute.onRequestGet, { path: `/api/analytics/post?id=${scheduled}` })).status === 404);
}

console.log('\nRoute: GET /api/analytics/export (kinds)');
{
  const free = make();
  check('Free: 402', (await call(free.env, exportRoute.onRequestGet, { path: '/api/analytics/export?kind=activity' })).status === 402);
  const { db, env } = make({ pro: true });
  db.exec(`UPDATE channels SET name = '=SUM(A1)' WHERE id = '${LI}'`);
  put(db, { ch: LI, at: ago(2) }); put(db, { ch: LI, at: ago(2), status: 'failed', error: 'x' }); put(db, { ch: TG, at: ago(1) });
  const day = (n) => new Date((NOW - n * DAY) * 1000).toISOString().slice(0, 10);
  db.prepare(`INSERT INTO channel_followers (channel_id, day, followers) VALUES (?, ?, ?), (?, ?, ?)`).run(BS, day(3), 10, BS, day(1), 14);
  const a = await call(env, exportRoute.onRequestGet, { path: '/api/analytics/export?kind=activity&days=30' });
  check('activity CSV: header and one line per day and channel', a.status === 200 && a.text.startsWith('"day","network","channel","sent","failed"') && a.text.split('\r\n').length === 3, a.text);
  check('activity CSV: file name', a.headers.get('content-disposition').includes('vane-activity.csv'));
  check('activity CSV: a name that starts with = is defused', a.text.includes(`"'=SUM(A1)"`), a.text);
  const f = await call(env, exportRoute.onRequestGet, { path: `/api/analytics/export?kind=followers&days=30&channels=${BS}` });
  check('followers CSV: one line per day, in order', f.text.split('\r\n').length === 3 && f.text.includes('"14"') && f.headers.get('content-disposition').includes('vane-followers.csv'), f.text);
  const other = await call(env, exportRoute.onRequestGet, { path: `/api/analytics/export?kind=followers&channels=${FOREIGN}` });
  check('followers CSV: another user’s channel is not exported', !other.text.includes('Other'));
  const p = await call(env, exportRoute.onRequestGet, { path: '/api/analytics/export' });
  check('the default CSV is still the posts one', p.text.startsWith('"date","network","channel","text"') && p.headers.get('content-disposition').includes('vane-analytics.csv'));
}

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) { console.log('Failed:\n - ' + failed.join('\n - ')); process.exit(1); }
