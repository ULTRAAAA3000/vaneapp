#!/usr/bin/env node
/**
 * Unit checks for the two dispatch lanes (worker/src/dispatch.ts, worker/src/priority.ts) on an in-memory SQLite copy of schema.sql.
 * No network: the channels have no usable credentials, so a claimed post comes back as a retry with its attempt counted and its
 * updated_at set to the second it was handled, which is exactly what shows WHICH lane claimed it and WHEN.  npm run test:unit
 */
import { build } from 'esbuild';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'vane-unit-'));
const out = join(dir, 'lanes.mjs');
await build({
  stdin: { contents: "export * from './worker/src/dispatch.ts'; export * from './worker/src/priority.ts'; export * from './functions/api/lib/paid.ts';", resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent',
});
const m = await import(pathToFileURL(out).href);
rmSync(dir, { recursive: true, force: true });

const NOW = 1_800_000_000;
function fresh() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync('schema.sql', 'utf8'));
  db.exec(`INSERT INTO users (id, email) VALUES ('paid', 'p@example.com'), ('free', 'f@example.com'), ('lapsed', 'l@example.com'), ('suite', 's@example.com'), ('devapi', 'd@example.com')`);
  db.exec(`INSERT INTO subscriptions (user_id, plan, status, current_period_end) VALUES ('paid', 'pro', 'active', ${NOW + 86400}), ('lapsed', 'pro', 'active', ${NOW - 10}), ('suite', 'suite', 'active', NULL), ('devapi', 'api', 'active', ${NOW + 86400})`);
  for (const u of ['paid', 'free', 'lapsed', 'suite', 'devapi']) db.prepare(`INSERT INTO channels (id, user_id, type, name, credentials) VALUES (?, ?, 'telegram', '@x', '{}')`).run(`ch-${u}`, u);
  const wrap = (sql) => { let args = []; const st = {
    bind(...a) { args = a; return st; },
    async first() { return db.prepare(sql).get(...args) ?? null; },
    async run() { const r = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes) } }; },
    async all() { return { results: db.prepare(sql).all(...args) }; },
    _exec() { return db.prepare(sql).run(...args); },
  }; return st; };
  const env = { ENCRYPTION_KEY: 'k'.repeat(40), DB: { prepare: wrap, async batch(list) { db.exec('BEGIN'); try { for (const s of list) s._exec(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } return []; } } };
  let n = 0;
  const post = (user, at, extra = {}) => { const id = `p${++n}-${user}`; db.prepare(`INSERT INTO posts (id, group_id, user_id, channel_id, content, scheduled_at, status, attempts) VALUES (?, 'g', ?, ?, 'hello', ?, ?, ?)`).run(id, user, `ch-${user}`, at, extra.status ?? 'scheduled', extra.attempts ?? 0); return id; };
  const state = (id) => { const r = db.prepare('SELECT status, updated_at, scheduled_at, attempts FROM posts WHERE id = ?').get(id); return { ...r, taken: r.attempts > 0 }; };   // a claimed post has its attempt counted (no credentials here, so it goes back to "scheduled" to retry)
  return { db, env, post, state };
}

let passed = 0;
const failed = [];
const check = (name, cond) => { if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed.push(name); console.log(`  ✗ ${name}`); } };
const quiet = console.error; console.error = () => {};

console.log('\nwho is paid');
{
  const { env } = fresh();
  check('Pro, the Suite: paid. Free Trial, an ended plan: not', (await m.isPaidAccount(env, 'paid', NOW)) && (await m.isPaidAccount(env, 'suite', NOW)) && !(await m.isPaidAccount(env, 'free', NOW)) && !(await m.isPaidAccount(env, 'lapsed', NOW)));
  check('the Developer API plan has no dashboard, so it is not a paid plan of the posting dashboard', !(await m.isPaidAccount(env, 'devapi', NOW)) && m.isDashboardPlan('pro') && m.isDashboardPlan('suite') && !m.isDashboardPlan('api') && !m.isDashboardPlan('free'));
}

console.log('\nthe lanes claim different accounts');
{
  const { env, post, state } = fresh();
  const a = post('paid', NOW - 5), b = post('free', NOW - 5), c = post('lapsed', NOW - 5), d = post('suite', NOW - 5), e = post('devapi', NOW - 5);
  await m.runDuePosts(env, NOW, { lane: 'priority', housekeeping: false });
  check('the priority lane takes the paid accounts (Pro, Suite) and leaves the rest', state(a).taken && state(d).taken && !state(b).taken && !state(c).taken && !state(e).taken);
  await m.runDuePosts(env, NOW, { lane: 'standard', housekeeping: false });
  check('the standard lane takes the Free Trial, a lapsed plan and the Developer API plan', state(b).taken && state(c).taken && state(e).taken);
}
{
  const { env, post, state } = fresh();
  const free = Array.from({ length: 60 }, () => post('free', NOW - 30));
  const paid = [post('paid', NOW - 1), post('paid', NOW - 1), post('suite', NOW - 1)];
  await m.runDueLanes(env, NOW, () => NOW);
  const freeTaken = free.filter((id) => state(id).taken).length;
  check('60 free posts due at once: only one standard batch (20) goes in a run', freeTaken === m.BATCH_SIZE);
  check('...and every paid post, due LATER than all of them, went in that same run (never waits behind free ones)', paid.every((id) => state(id).taken));
}
{
  const { env, post, state } = fresh();
  const oldFirst = Array.from({ length: 25 }, () => post('free', NOW - 600));
  const mine = post('paid', NOW - 1);
  await m.runDuePosts(env, NOW, { lane: 'all' });
  check('without lanes (the old behaviour) the paid post WOULD wait behind older free ones', !state(mine).taken && oldFirst.filter((id) => state(id).taken).length === m.BATCH_SIZE);
}
{
  const { env, post, state } = fresh();
  const ids = Array.from({ length: 45 }, () => post('paid', NOW - 1));
  await m.runDuePosts(env, NOW, { lane: 'priority', housekeeping: false });
  check('the priority lane has the bigger batch (40)', ids.filter((id) => state(id).taken).length === m.PRIORITY_BATCH_SIZE);
}
{
  const { env, post, state } = fresh();
  const id = post('paid', NOW - 1);
  env.DB.prepare(`UPDATE posts SET status = 'cancelled' WHERE id = ?`).bind(id)._exec();
  await m.runDueLanes(env, NOW, () => NOW);
  check('a post cancelled before the claim is never sent', state(id).status === 'cancelled');
}
{
  const { env, post, db } = fresh();
  const id = post('paid', NOW - 1);
  await m.runDuePosts(env, NOW, { lane: 'priority', housekeeping: false });
  check('every claimed post leaves a log line (the lane is in the meta of the sent ones)', db.prepare('SELECT COUNT(*) AS n FROM logs WHERE post_id = ?').get(id).n >= 1);
}

console.log('\nhousekeeping runs once, not per lane');
{
  const { env, post, state } = fresh();
  const old = post('free', NOW - 3 * 3600);
  await m.runDuePosts(env, NOW, { lane: 'priority', housekeeping: false });
  check('a priority run without housekeeping leaves an overdue post alone', state(old).status === 'scheduled' && !state(old).taken);
  await m.runDuePosts(env, NOW, { lane: 'priority', housekeeping: true });
  check('with housekeeping, a post more than 2 hours late is failed, whoever owns it', state(old).status === 'failed');
}

console.log('\nsending on the second');
{
  const { env, post, state } = fresh();
  const a = post('paid', NOW + 5), b = post('paid', NOW + 5), c = post('suite', NOW + 20), f = post('free', NOW + 10), far = post('paid', NOW + 90), retry = post('paid', NOW + 30, { attempts: 2 });
  const seen = await m.upcomingPrioritySeconds(env, NOW);
  check('the look-ahead lists the distinct seconds of paid first attempts within 58 s, in order', JSON.stringify(seen) === JSON.stringify([NOW + 5, NOW + 20]));

  let clock = NOW * 1000 + 700;                                  // the cron run starts 0.7 s into the second
  const slept = [];
  const deps = { now: () => clock, sleep: async (ms) => { slept.push(ms); clock += ms; }, run: (e, sec) => m.runDuePosts(e, sec, { lane: 'priority', housekeeping: false }) };
  const r = await m.runPriorityLane(env, deps);
  check('it woke up for each second, and only for those', JSON.stringify(r.wakeups) === JSON.stringify([NOW + 5, NOW + 20]));
  check('it waited until the second, not past it', slept.length === 2 && slept[0] === 4300 && slept[1] === 15000);
  check('a post due at +5 s was handled AT +5 s, one due at +20 s AT +20 s (not at the next whole minute)', state(a).updated_at === NOW + 5 && state(b).updated_at === NOW + 5 && state(c).updated_at === NOW + 20);
  check('two posts due in the same second went together', r.claimed === 3);
  check('the free post, the one 90 s away and the retry were left alone', !state(f).taken && !state(far).taken && state(retry).attempts === 2);
}
{
  const { env, post, state } = fresh();
  const id = post('paid', NOW + 10);
  let clock = NOW * 1000;
  const deps = { now: () => clock, sleep: async (ms) => { clock += ms; env.DB.prepare(`UPDATE posts SET status = 'cancelled' WHERE id = ?`).bind(id)._exec(); }, run: (e, sec) => m.runDuePosts(e, sec, { lane: 'priority', housekeeping: false }) };
  const r = await m.runPriorityLane(env, deps);
  check('a post cancelled while the lane was waiting is not sent (the claim happens at the second, not before)', state(id).status === 'cancelled' && !state(id).taken && r.claimed === 0);
}
{
  const { env, post, state } = fresh();
  const id = post('paid', NOW + 10);
  const r = await m.runPriorityLane({ ...env, ENCRYPTION_KEY: '' }, { now: () => NOW * 1000, sleep: async () => {}, run: async () => { throw new Error('must not run'); } });
  check('without an encryption key the lane touches nothing (the same fail-safe as the main run)', r.wakeups.length === 0 && !state(id).taken);
}

console.error = quiet;
console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
