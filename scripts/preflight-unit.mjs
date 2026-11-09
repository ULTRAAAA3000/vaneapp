#!/usr/bin/env node
/**
 * Early warning: findProblems (what will stop a scheduled post from going out), the email the cron sends ahead of time and
 * the /api/posts/preflight route, on the REAL code and schema.sql (in-memory SQLite).   npm run test:unit
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
  `export * as pre from '${root}/functions/api/lib/preflight.ts';`,
  `export * as cron from '${root}/worker/src/preflight.ts';`,
  `export * as route from '${root}/functions/api/posts/preflight.ts';`,
  `export * as crypto from '${root}/functions/api/lib/crypto.ts';`,
  `export * as session from '${root}/functions/api/lib/session.ts';`,
  `export * as networks from '${root}/functions/api/lib/networks.ts';`,
].join('\n'));
await build({ entryPoints: [join(dir, 'entry.ts')], bundle: true, format: 'esm', platform: 'node', outfile: join(dir, 'all.mjs'), logLevel: 'silent' });
const { pre, cron, route, crypto: vcrypto, session, networks } = await import(pathToFileURL(join(dir, 'all.mjs')).href);
rmSync(dir, { recursive: true, force: true });

let passed = 0;
const failed = [];
const check = (name, cond, extra = '') => { if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed.push(name); console.log(`  ✗ ${name} ${extra}`); } };

const KEY = 'k'.repeat(40);
const NOW = 1_800_000_000;
const H = 3600;
const D = 86400;
const IDS = { tg: '11111111-1111-4111-8111-111111111111', li: '22222222-2222-4222-8222-222222222222', th: '33333333-3333-4333-8333-333333333333', x: '44444444-4444-4444-8444-444444444444', off: '55555555-5555-4555-8555-555555555555', bs: '66666666-6666-4666-8666-666666666666' };

async function make() {
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
  const env = { ENCRYPTION_KEY: KEY, JWT_SECRET: 'j'.repeat(40), RESEND_API_KEY: 're_x', EMAIL_FROM: 'Vane <noreply@vaneapp.dev>', APP_URL: 'https://vaneapp.dev',
    DB: { prepare: mk, async batch(st) { const o = []; for (const s of st) o.push(await s.run()); return o; } } };
  db.exec(`INSERT INTO users (id, email) VALUES ('u1', 'a@example.com'), ('u2', 'b@example.com')`);
  return { db, env };
}
const enc = (o) => vcrypto.encryptToken(JSON.stringify(o), KEY);
const li = (expiresAt, refreshToken) => ({ type: 'linkedin', urn: 'urn:li:person:abc123', name: 'Me', accessToken: 'a', expiresAt, ...(refreshToken ? { refreshToken } : {}) });
const th = (expiresAt) => ({ type: 'threads', userId: '123456', username: 'me', accessToken: 'a', expiresAt });

async function seed(db, over = {}) {
  const ch = (id, user, type, name, creds, active = 1) => db.prepare(`INSERT INTO channels (id, user_id, type, name, credentials, is_active) VALUES (?, ?, ?, ?, ?, ?)`).run(id, user, type, name, creds, active);
  ch(IDS.tg, 'u1', 'telegram', 'News', 'x');
  ch(IDS.li, 'u1', 'linkedin', 'My LinkedIn', await enc(over.li ?? li(NOW + 30 * D, 'r')));
  ch(IDS.th, 'u1', 'threads', 'My Threads', await enc(over.th ?? th(NOW + 30 * D)));
  ch(IDS.bs, 'u1', 'bluesky', 'Sky', 'x');
  ch(IDS.off, 'u1', 'mastodon', 'Old', 'x', 0);
}
let n = 0;
const post = (db, channel, at, status = 'scheduled', error = null, user = 'u1') => db.prepare(`INSERT INTO posts (id, group_id, user_id, channel_id, content, scheduled_at, status, error, sent_at, updated_at) VALUES (?, ?, ?, ?, 'hi', ?, ?, ?, ?, ?)`)
  .run(`p${++n}`, `g${n}`, user, channel, at, status, error, status === 'sent' ? at : null, at);
const by = (list, id) => list.find((p) => p.channelId === id);

console.log('\nNothing wrong, nothing said');
{
  const { db, env } = await make(); await seed(db);
  for (const c of [IDS.tg, IDS.li, IDS.th, IDS.bs]) post(db, c, NOW + 2 * H);
  check('healthy channels: no warnings', (await pre.findProblems(env, NOW)).length === 0);
  check('no scheduled posts at all: no warnings', (await pre.findProblems((await make()).env, NOW)).length === 0);
}

console.log('\nSwitched off and paused');
{
  const { db, env } = await make(); await seed(db);
  post(db, IDS.off, NOW + 2 * H); post(db, IDS.off, NOW + 5 * H);
  const p = by(await pre.findProblems(env, NOW), IDS.off);
  check('a switched-off channel with posts waiting', p && p.code === 'inactive' && p.postCount === 2 && p.firstAt === NOW + 2 * H && p.reconnect === false && /switched off/.test(p.message), JSON.stringify(p));
  post(db, IDS.bs, NOW + 3 * H);
  networks.invalidateNetworkFlags();
  db.prepare(`INSERT INTO network_flags (network, enabled, note) VALUES ('bluesky', 0, '')`).run();
  const q = by(await pre.findProblems(env, NOW), IDS.bs);
  check("a network the admin paused: the posts will wait, and the person is told", q && q.code === 'paused' && /paused/.test(q.message), JSON.stringify(q));
  networks.invalidateNetworkFlags();
}

console.log('\nSign-ins that run out');
{
  const { db, env } = await make(); await seed(db, { li: li(NOW - 2 * D), th: th(NOW + 1 * D) });
  post(db, IDS.li, NOW + 2 * H); post(db, IDS.th, NOW + 3 * D);
  const l = by(await pre.findProblems(env, NOW), IDS.li);
  check('LinkedIn sign-in already expired', l && l.code === 'expired' && l.reconnect === true && /expired on/.test(l.message), JSON.stringify(l));
  const t = by(await pre.findProblems(env, NOW), IDS.th);
  check('Threads sign-in that runs out before the post is due', t && t.code === 'expiring' && t.reconnect === true && /runs out on/.test(t.message), JSON.stringify(t));
}
{
  const { db, env } = await make(); await seed(db, { th: th(NOW + 10 * D) });
  post(db, IDS.th, NOW + 3 * D);
  check('a sign-in that lasts past the post: fine', by(await pre.findProblems(env, NOW), IDS.th) === undefined);
}
{
  const { db, env } = await make(); await seed(db, { li: li(NOW + 2 * D) });
  post(db, IDS.li, NOW + 5 * D);
  check('LinkedIn without a refresh token running out before the post: warned', by(await pre.findProblems(env, NOW), IDS.li)?.code === 'expiring');
}
{
  const { db, env } = await make(); await seed(db, { li: li(NOW - D) });
  check('a sign-in that has expired but has no posts waiting: no noise', (await pre.findProblems(env, NOW)).length === 0);
}

console.log('\nThe last post failed because of the sign-in');
{
  const { db, env } = await make(); await seed(db);
  post(db, IDS.bs, NOW - 3 * H, 'failed', 'Bluesky said 401: ExpiredToken');
  post(db, IDS.bs, NOW + 2 * H);
  const p = by(await pre.findProblems(env, NOW), IDS.bs);
  check('an auth-type failure predicts the next one', p && p.code === 'last_failed' && p.reconnect && /401/.test(p.message), JSON.stringify(p));
  post(db, IDS.tg, NOW - 3 * H, 'failed', 'Message is too long'); post(db, IDS.tg, NOW + 2 * H);
  check('a failure that is not about the sign-in (text too long) is not a channel problem', by(await pre.findProblems(env, NOW), IDS.tg) === undefined);
  post(db, IDS.bs, NOW - 1 * H, 'sent');
  check('a later success clears it', by(await pre.findProblems(env, NOW), IDS.bs) === undefined);
}
{
  const { db, env } = await make(); await seed(db);
  post(db, IDS.bs, NOW - 20 * D, 'failed', 'token expired'); post(db, IDS.bs, NOW + 2 * H);
  check('an old failure (over 14 days) is forgotten', by(await pre.findProblems(env, NOW), IDS.bs) === undefined);
}

console.log('\nWho sees what');
{
  const { db, env } = await make(); await seed(db);
  db.prepare(`INSERT INTO channels (id, user_id, type, name, credentials, is_active) VALUES ('77777777-7777-4777-8777-777777777777', 'u2', 'telegram', 'Theirs', 'x', 0)`).run();
  post(db, IDS.off, NOW + H); post(db, '77777777-7777-4777-8777-777777777777', NOW + H, 'scheduled', null, 'u2');
  const mine = await pre.findProblems(env, NOW, { userId: 'u1' });
  check("one person's check never includes another person's channels", mine.length === 1 && mine[0].userId === 'u1');
  check('the cron sees everyone', (await pre.findProblems(env, NOW)).length === 2);
  post(db, IDS.tg, NOW + 30 * D);
  db.prepare(`UPDATE channels SET is_active = 0 WHERE id = ?`).run(IDS.tg);
  check('posts more than 7 days away are not looked at yet', by(await pre.findProblems(env, NOW), IDS.tg) === undefined);
  const early = await pre.findProblems(env, NOW, { startsWithin: 12 * H });
  check('startsWithin keeps only channels whose first post is near', early.every((p) => p.firstAt <= NOW + 12 * H));
}

console.log('\nThe route');
async function ask(env, user) {
  const t = await session.createSession(env, new Request('https://vaneapp.dev/'), user);
  const res = await route.onRequestGet({ request: new Request('https://vaneapp.dev/api/posts/preflight', { headers: { cookie: `vane_session=${t}`, 'cf-connecting-ip': '203.0.113.9' } }), env, params: {}, waitUntil() {} });
  return { status: res.status, data: await res.json().catch(() => null) };
}
{
  const { db, env } = await make(); await seed(db);
  const realNow = Math.floor(Date.now() / 1000);
  post(db, IDS.off, realNow + 2 * H);
  const r = await ask(env, 'u1');
  check('the route returns my problems without the user id', r.status === 200 && r.data.problems.length === 1 && r.data.problems[0].code === 'inactive' && !('userId' in r.data.problems[0]), JSON.stringify(r));
  check("another person gets an empty list", (await ask(env, 'u2')).data.problems.length === 0);
  const anon = await route.onRequestGet({ request: new Request('https://vaneapp.dev/api/posts/preflight'), env, params: {}, waitUntil() {} });
  check('signed out: 401', anon.status === 401);
}

console.log('\nThe email, ahead of time');
const sent = [];
globalThis.fetch = async (url, init) => { sent.push({ url: String(url), body: JSON.parse(init.body) }); return new Response('{}', { status: 200 }); };
{
  const { db, env } = await make(); await seed(db);
  post(db, IDS.off, NOW + 2 * H); post(db, IDS.off, NOW + 4 * H); post(db, IDS.bs, NOW + 40 * H);
  db.prepare(`UPDATE channels SET is_active = 0 WHERE id = ?`).run(IDS.bs);
  check('isPreflightMinute: every 10 minutes', cron.isPreflightMinute(600) && cron.isPreflightMinute(1200) && !cron.isPreflightMinute(660));
  const n1 = await cron.runPreflight(env, NOW);
  check('one email per person, only for posts due within 12 hours', n1 === 1 && sent.length === 1 && sent[0].body.to[0] === 'a@example.com', JSON.stringify(sent.map((s) => s.body.to)));
  const body = sent[0]?.body ?? {};
  check('it says how many posts, which channel, when and why', /2 scheduled posts may not go out/.test(body.subject) && /Old/.test(body.text) && /2 posts/.test(body.text) && /switched off/.test(body.text) && /UTC/.test(body.text), body.subject);
  check('it links to the app and has an unsubscribe footer', /vaneapp\.dev\/app/.test(body.text) && /Unsubscribe/.test(body.text));
  check('the far-away channel is not in it', !/Sky/.test(body.text));
  check('it is remembered in the log', db.prepare(`SELECT COUNT(*) n FROM logs WHERE event = 'preflight.warn' AND channel_id = ?`).get(IDS.off).n === 1);
  const n2 = await cron.runPreflight(env, NOW + 10 * 60);
  check('ten minutes later: no second email for the same problem', n2 === 0 && sent.length === 1);
  const n3 = await cron.runPreflight(env, NOW + 25 * H);
  check('a day later and still broken: one reminder', n3 === 1 && sent.length === 2, String(n3));
}
{
  const { db, env } = await make(); await seed(db);
  post(db, IDS.off, NOW + 2 * H);
  sent.length = 0;
  env.RESEND_API_KEY = undefined;
  check('no email service set up: the cron does nothing and does not fail', (await cron.runPreflight(env, NOW)) === 0 && sent.length === 0);
}
{
  const { db, env } = await make(); await seed(db);
  post(db, IDS.off, NOW + 2 * H);
  db.prepare(`INSERT INTO email_optouts (email) VALUES ('a@example.com')`).run();
  sent.length = 0;
  await cron.runPreflight(env, NOW);
  check('someone who unsubscribed from emails gets none', sent.length === 0);
}
{
  const { db, env } = await make(); await seed(db);
  post(db, IDS.off, NOW + 2 * H);
  sent.length = 0;
  globalThis.fetch = async () => new Response('{}', { status: 500 });
  check('the email service failing: nothing is marked as sent, so the next run tries again', (await cron.runPreflight(env, NOW)) === 0 && db.prepare(`SELECT COUNT(*) n FROM logs WHERE event = 'preflight.warn'`).get().n === 0);
  const m = cron.warningMail('x@example.com', [{ userId: 'u1', channelId: 'c', platform: 'x', name: '<b>Tricky</b>', code: 'inactive', message: 'a & b', reconnect: false, postCount: 1, firstAt: NOW }], 'https://vaneapp.dev');
  check('names are escaped in the HTML', !m.html.includes('<b>Tricky</b>') && m.html.includes('&lt;b&gt;Tricky') && /1 scheduled post may not go out/.test(m.subject));
}

console.log('\nThe page');
{
  const app = readFileSync('public/app.html', 'utf8');
  check('the dashboard has the warning box and loads preflight.js', /id="preflight"/.test(app) && /\/assets\/preflight\.js/.test(app));
  const js = readFileSync('public/assets/preflight.js', 'utf8');
  check('it uses the route and the Reconnect flow of the Channels card', /\/api\/posts\/preflight/.test(js) && /Vane\.openConnect/.test(js));
  check('the dashboard exposes openConnect', /Vane\.openConnect = openConnect/.test(readFileSync('public/assets/dashboard.js', 'utf8')));
}

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) { console.log('Failed:\n - ' + failed.join('\n - ')); process.exit(1); }
