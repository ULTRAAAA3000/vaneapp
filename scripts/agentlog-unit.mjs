#!/usr/bin/env node
/** Unit checks for the agent log (functions/api/lib/agentlog.ts) on an in-memory SQLite copy of schema.sql, no network:  npm run test:unit */
import { build } from 'esbuild';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'vane-unit-'));
const load = async (entry, name) => {
  const out = join(dir, `${name}.mjs`);
  await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent' });
  return import(pathToFileURL(out).href);
};
const outFile = join(dir, 'both.mjs');
await build({
  stdin: { contents: "export * from './functions/api/lib/agentlog.ts'; export * from './functions/api/lib/integrations.ts';", resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, format: 'esm', platform: 'node', outfile: outFile, logLevel: 'silent',
});
const log = await import(pathToFileURL(outFile).href), integ = log;   // one bundle: the log and the integrations share the same request markers
rmSync(dir, { recursive: true, force: true });

function fresh() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync('schema.sql', 'utf8'));
  db.exec(`INSERT INTO users (id, email) VALUES ('u1', 'a@example.com'), ('u2', 'b@example.com'), ('free', 'f@example.com'), ('lapsed', 'l@example.com'), ('gone', 'g@example.com')`);
  // u1 and u2 are on a paid plan with no expiry; "free" has no subscription; "lapsed" had Pro that ended; "gone" cancelled it.
  db.exec(`INSERT INTO subscriptions (user_id, plan, status, current_period_end) VALUES ('u1', 'pro', 'active', NULL), ('u2', 'suite', 'active', 4102444800), ('lapsed', 'pro', 'active', 1000), ('gone', 'pro', 'canceled', 4102444800)`);
  const env = { DB: { prepare(sql) {
    let args = [];
    const st = {
      bind(...a) { args = a; return st; },
      async first() { return db.prepare(sql).get(...args) ?? null; },
      async run() { const r = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes) } }; },
      async all() { return { results: db.prepare(sql).all(...args) }; },
    };
    return st;
  } } };
  return { db, env };
}

let passed = 0;
const failed = [];
const check = (name, cond) => { if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed.push(name); console.log(`  ✗ ${name}`); } };
const ev = (o = {}) => ({ userId: 'u1', integration: 'claude', via: 'mcp', tool: 'vane_list_channels', ok: true, message: 'Executed tool: vane_list_channels() → 4 channels found', ...o });
const quiet = console.error; console.error = () => {};

console.log('\nwriting and reading lines');
{
  const { env } = fresh();
  for (let i = 1; i <= 5; i++) await log.recordAgentEvent(env, ev({ message: `line ${i}`, integration: i % 2 ? 'claude' : 'make' }), 1000 + i);
  await log.recordAgentEvent(env, ev({ userId: 'u2', message: 'someone else' }), 1100);
  const all = await log.listAgentEvents(env, 'u1', { limit: 3 });
  check('without a cursor: the newest lines, oldest first', all.events.map((e) => e.message).join() === 'line 3,line 4,line 5');
  check('the cursor is the id of the newest line of the person', all.latest === all.events[2].id);
  const more = await log.listAgentEvents(env, 'u1', { after: all.events[0].id });
  check('with a cursor: only the lines after it, oldest first', more.events.map((e) => e.message).join() === 'line 4,line 5');
  const none = await log.listAgentEvents(env, 'u1', { after: all.latest });
  check('nothing new gives an empty list', none.events.length === 0 && none.latest === all.latest);
  const only = await log.listAgentEvents(env, 'u1', { integration: 'make' });
  check('a filter keeps one integration', only.events.length === 2 && only.events.every((e) => e.integration === 'make'));
  check('another person\'s lines never show', !(await log.listAgentEvents(env, 'u1')).events.some((e) => e.message === 'someone else'));
  const e0 = all.events[0];
  check('a line carries time, integration, via, tool and the ok flag', e0.at === 1003 && e0.via === 'mcp' && e0.tool === 'vane_list_channels' && e0.ok === true && e0.integration === 'claude');
  check('a bad filter value is ignored, not injected', (await log.listAgentEvents(env, 'u1', { integration: "x' OR 1=1 --" })).events.length === 5);
  await log.recordAgentEvent(env, ev({ message: 'x'.repeat(500) }), 1200);
  check('a very long line is cut', (await log.listAgentEvents(env, 'u1', { limit: 1 })).events[0].message.length <= 200);
}

console.log('\na paid-plan feature');
{
  const { db, env } = fresh();
  const now = 1_800_000_000;
  check('a paid plan may have the log (Pro, and the Suite)', (await log.agentLogAllowed(env, 'u1', now)) === true && (await log.agentLogAllowed(env, 'u2', now)) === true);
  check('the Free Trial may not', (await log.agentLogAllowed(env, 'free', now)) === false);
  check('a paid plan that has ended may not', (await log.agentLogAllowed(env, 'lapsed', now)) === false);
  check('a cancelled plan may not', (await log.agentLogAllowed(env, 'gone', now)) === false);
  check('an unknown account may not', (await log.agentLogAllowed(env, 'nobody', now)) === false);
  for (const id of ['free', 'lapsed', 'gone']) await log.recordAgentEvent(env, ev({ userId: id }), now);
  check('nothing is recorded for the Free Trial, a lapsed plan or a cancelled one', db.prepare('SELECT COUNT(*) AS n FROM agent_events').get().n === 0);
  await log.recordAgentEvent(env, ev({ userId: 'u1' }), now);
  check('a paid account is recorded', db.prepare('SELECT COUNT(*) AS n FROM agent_events').get().n === 1);
  db.exec(`UPDATE subscriptions SET status = 'canceled' WHERE user_id = 'u1'`);
  await log.recordAgentEvent(env, ev({ userId: 'u1' }), now);
  check('the moment a plan is cancelled the recording stops', db.prepare('SELECT COUNT(*) AS n FROM agent_events').get().n === 1);
  db.exec(`INSERT INTO agent_events (user_id, integration, via, ok, message) VALUES ('free', 'claude', 'mcp', 1, 'left over')`);
  await log.clearAgentEvents(env, 'free');
  check('anyone can still wipe what was kept (a downgrade does not trap the lines)', db.prepare(`SELECT COUNT(*) AS n FROM agent_events WHERE user_id = 'free'`).get().n === 0);
}

console.log('\nkeeping it small');
{
  const { db, env } = fresh();
  const now = 1_800_000_000;
  db.prepare(`INSERT INTO agent_events (user_id, integration, via, tool, ok, message, created_at) VALUES ('u1','make','api',NULL,1,'ancient',?)`).run(now - 31 * 86400);
  for (let i = 0; i < 320; i++) db.prepare(`INSERT INTO agent_events (user_id, integration, via, tool, ok, message, created_at) VALUES ('u1','claude','mcp',NULL,1,?,?)`).run(`n${i}`, now - 100);
  await log.prune(env, 'u1', now);
  const left = db.prepare(`SELECT COUNT(*) AS n FROM agent_events WHERE user_id='u1'`).get().n;
  check('only the newest 300 lines stay (and nothing older than 30 days)', left === 300 && !db.prepare(`SELECT 1 FROM agent_events WHERE message='ancient'`).get());
  check('the newest line survived, the oldest did not', !!db.prepare(`SELECT 1 FROM agent_events WHERE message='n319'`).get() && !db.prepare(`SELECT 1 FROM agent_events WHERE message='n0'`).get());
  await log.clearAgentEvents(env, 'u1');
  check('clearing wipes the person\'s lines', db.prepare(`SELECT COUNT(*) AS n FROM agent_events WHERE user_id='u1'`).get().n === 0);
}

console.log('\nwhat a line says');
{
  const d = log.describeRest;
  check('channels', d('channels.list', 'GET', 200, { channels: [1, 2, 3, 4] }).message === 'Listed channels → 4 channels found' && d('channels.list', 'GET', 200, { channels: [1] }).message.endsWith('1 channel found'));
  check('a scheduled post: when and how many channels', d('posts.create', 'POST', 201, { scheduledAt: 1793610000, posts: [1, 2] }).message === 'Scheduled a post for 2026-11-02 09:00 UTC on 2 channels');
  check('a test key says nothing was posted', /Test run/.test(d('posts.create', 'POST', 201, { scheduledAt: 1793610000, posts: [1], test: true }).message) && /nothing posted/.test(d('posts.create', 'POST', 201, { scheduledAt: 1793610000, posts: [1], test: true }).message));
  const bad = d('posts.create', 'POST', 402, { ok: false, code: 'quota_exceeded', error: 'Quota gone for "my secret launch text"' });
  check('a refusal shows the CODE only, never the message (it may quote the post)', bad.ok === false && bad.message === 'Schedule a post → refused: quota_exceeded' && !/secret/.test(bad.message));
  check('a refusal without a code shows the status', d('posts.list', 'GET', 500, null).message === 'Looked up posts → refused (500)');
  check('the post text never appears, even when the answer carries it', !/launch/.test(d('posts.list', 'GET', 200, { posts: [{ content: 'secret launch' }] }).message));
  check('an MCP line has the tool, its arguments and the outcome', log.mcpLine('vane_create_post', '2 channels', 'scheduled for 2026-11-02 09:00 UTC') === 'Executed tool: vane_create_post(2 channels) → scheduled for 2026-11-02 09:00 UTC');
  check('times are written in UTC', log.utc(1793610000) === '2026-11-02 09:00 UTC');
}

console.log('\nthe REST wrapper');
{
  const { env, db } = fresh();
  const rows = () => db.prepare('SELECT integration, via, ok, message FROM agent_events ORDER BY id').all();
  const handler = (status, body, headers = {}) => async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const call = async (wrapped, request) => wrapped({ request, env });

  let req = new Request('https://x.dev/api/v1/channels');
  integ.rememberAuth(req, { userId: 'u1', keyId: 'k1', integration: 'zapier' });
  const res = await call(log.agentLogged('channels.list', handler(200, { ok: true, channels: [1, 2] })), req);
  check('the answer reaches the caller untouched, and a line is written for the integration', (await res.json()).channels.length === 2 && rows().length === 1 && rows()[0].integration === 'zapier' && rows()[0].via === 'api' && rows()[0].message === 'Listed channels → 2 channels found');

  req = new Request('https://x.dev/api/v1/posts', { method: 'POST' });
  integ.rememberAuth(req, { userId: 'u1', keyId: 'k1', integration: 'obsidian' });
  await call(log.agentLogged('posts.create', handler(402, { ok: false, code: 'quota_exceeded', error: 'x' })), req);
  check('a failed call is logged as a refusal', rows()[1].ok === 0 && rows()[1].message === 'Schedule a post → refused: quota_exceeded');

  const before = rows().length;
  req = new Request('https://x.dev/api/v1/channels');                                    // never accepted (no key): nobody to write for
  await call(log.agentLogged('channels.list', handler(401, { ok: false, code: 'invalid_api_key' })), req);
  check('a request without an accepted key writes nothing', rows().length === before);

  const outer = new Request('https://x.dev/api/v1/mcp'), inner = new Request('https://x.dev/api/v1/channels');
  integ.markMcpInternal(inner, outer); integ.rememberAuth(inner, { userId: 'u1', keyId: 'k1', integration: 'claude' });
  await call(log.agentLogged('channels.list', handler(200, { channels: [] })), inner);
  check('the inner calls of an MCP tool are skipped (the tool call is the line)', rows().length === before);

  req = new Request('https://x.dev/api/v1/posts', { method: 'POST' });
  integ.rememberAuth(req, { userId: 'u1', keyId: 'k1', integration: 'make' });
  await call(log.agentLogged('posts.create', handler(201, { ok: true, posts: [1] }, { 'Idempotent-Replayed': 'true' })), req);
  check('a replayed request (same Idempotency-Key) is not a second event', rows().length === before);

  req = new Request('https://x.dev/api/v1/channels'); integ.rememberAuth(req, { userId: 'free', keyId: 'k2', integration: 'make' });
  await call(log.agentLogged('channels.list', handler(200, { channels: [1] })), req);
  check('a call made by a Free Trial account leaves no line', rows().length === before);

  db.exec('DROP TABLE agent_events');
  req = new Request('https://x.dev/api/v1/channels'); integ.rememberAuth(req, { userId: 'u1', keyId: 'k1', integration: 'make' });
  const ok = await call(log.agentLogged('channels.list', handler(200, { channels: [] })), req);
  check('with the table missing the request still succeeds', ok.status === 200);
}

console.error = quiet;
console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
