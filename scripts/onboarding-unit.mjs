#!/usr/bin/env node
/** Unit checks for the onboarding checklist (functions/api/lib/onboarding.ts) on an in-memory SQLite copy of schema.sql, no network:  npm run test:unit */
import { build } from 'esbuild';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'vane-unit-'));
await build({ entryPoints: ['functions/api/lib/onboarding.ts'], bundle: true, format: 'esm', platform: 'node', outfile: join(dir, 'onboarding.mjs'), logLevel: 'silent' });
const ob = await import(pathToFileURL(join(dir, 'onboarding.mjs')).href);
rmSync(dir, { recursive: true, force: true });

function fresh() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync('schema.sql', 'utf8'));
  db.exec(`INSERT INTO users (id, email) VALUES ('u1', 'a@example.com')`);
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
  let n = 0;
  const add = {
    channel: () => db.exec(`INSERT INTO channels (id, user_id, type, name, credentials) VALUES ('c1', 'u1', 'telegram', '@x', '{}')`),
    key: (integration = null, revoked = false) => db.prepare(`INSERT INTO api_keys (id, user_id, name, scope, mode, key_hash, hint, integration, revoked_at) VALUES (?, 'u1', 'k', 'post', 'live', ?, 'abcd', ?, ?)`).run(`k${++n}`, `h${n}`, integration, revoked ? 1 : null),
    post: (status) => db.prepare(`INSERT INTO posts (id, group_id, user_id, channel_id, content, scheduled_at, status) VALUES (?, 'g', 'u1', 'c1', 'hi', 1, ?)`).run(`p${++n}`, status),
  };
  return { db, env, add };
}

let passed = 0;
const failed = [];
const check = (name, cond) => { if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed.push(name); console.log(`  ✗ ${name}`); } };
const done = (s) => s.steps.filter((x) => x.done).map((x) => x.id).join(',');

console.log('\nwhat counts as done');
{
  const { env, add } = fresh();
  const s0 = await ob.loadOnboarding(env, 'u1');
  check('a new account: nothing done, the card is shown, no confetti', s0.done === 0 && s0.total === 4 && !s0.hidden && !s0.celebrate);
  add.channel();
  check('a connected channel ticks "channel"', done(await ob.loadOnboarding(env, 'u1')) === 'channel');
  add.key(null, true);
  check('an API key ticks "key", even a revoked one', done(await ob.loadOnboarding(env, 'u1')) === 'channel,key');
  add.key('api');
  check('a key for "my own script" is not an integration', !(await ob.loadOnboarding(env, 'u1')).steps.find((x) => x.id === 'integration').done);
  add.post('scheduled'); add.post('failed');
  check('a scheduled or failed post is not a published post', !(await ob.loadOnboarding(env, 'u1')).steps.find((x) => x.id === 'post').done);
  add.post('sent');
  check('a SENT post ticks "post"', (await ob.loadOnboarding(env, 'u1')).steps.find((x) => x.id === 'post').done);
  add.key('notion');
  const s = await ob.loadOnboarding(env, 'u1');
  check('a key made for Notion ticks "integration"; four of four', done(s) === 'channel,key,post,integration' && s.done === 4);
}

console.log('\nthe confetti moment');
{
  const { env, add } = fresh();
  await ob.loadOnboarding(env, 'u1');                                   // the card has been seen incomplete
  add.channel(); add.key('make'); add.post('sent');
  const s = await ob.loadOnboarding(env, 'u1');
  check('completing the last step while the card exists asks for the confetti, once', s.celebrate === true && s.hidden === false);
  check('the celebration is only accepted when it is true', (await ob.markOnboarding(env, 'u1', 'celebrated')) === true);
  const after = await ob.loadOnboarding(env, 'u1');
  check('after it is shown the card is gone and the confetti does not come back', after.hidden === true && after.celebrate === false);
}
{
  const { env, add } = fresh();
  add.channel(); add.key('claude'); add.post('sent');
  const s = await ob.loadOnboarding(env, 'u1');
  check('an account that is ALREADY complete gets no confetti and no card (old news)', s.hidden === true && s.celebrate === false);
}
{
  const { env, add } = fresh();
  await ob.loadOnboarding(env, 'u1');
  check('"celebrated" is refused while a step is missing', (await ob.markOnboarding(env, 'u1', 'celebrated')) === false);
  add.channel();
  await ob.markOnboarding(env, 'u1', 'dismiss');
  check('closing the card hides it for good', (await ob.loadOnboarding(env, 'u1')).hidden === true);
  add.key('make'); add.post('sent');
  const s = await ob.loadOnboarding(env, 'u1');
  check('a closed card stays closed and does not celebrate later', s.hidden === true && s.celebrate === false);
}

console.log('\nrobustness');
{
  const { db, env } = fresh();
  db.exec('DROP TABLE onboarding_progress');
  const s = await ob.loadOnboarding(env, 'u1');
  check('without the table the card just stays hidden, nothing throws', s.hidden === true && s.celebrate === false);
}

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
