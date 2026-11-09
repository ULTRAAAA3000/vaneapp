#!/usr/bin/env node
/**
 * The library storage limit (Free Trial 10 MB, paid plans 100 MB, in total per account) on the REAL upload / list / delete handlers and
 * schema.sql (in-memory SQLite, a fake R2 bucket, real PNG files of exact sizes).   npm run test:unit
 */
import { build } from 'esbuild';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';

const dir = mkdtempSync(join(tmpdir(), 'vane-unit-'));
const root = process.cwd();
writeFileSync(join(dir, 'entry.ts'), [
  `export * as upload from '${root}/functions/api/media/upload.ts';`,
  `export * as list from '${root}/functions/api/library/assets/index.ts';`,
  `export * as one from '${root}/functions/api/library/assets/[id].ts';`,
  `export * as usageApi from '${root}/functions/api/library/usage.ts';`,
  `export * as session from '${root}/functions/api/lib/session.ts';`,
  `export * as settings from '${root}/functions/api/lib/settings.ts';`,
].join('\n'));
await build({ entryPoints: [join(dir, 'entry.ts')], bundle: true, format: 'esm', platform: 'node', outfile: join(dir, 'all.mjs'), logLevel: 'silent' });
const { upload, list, one, usageApi, session, settings } = await import(pathToFileURL(join(dir, 'all.mjs')).href);
rmSync(dir, { recursive: true, force: true });

let passed = 0;
const failed = [];
const check = (name, cond, extra = '') => { if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed.push(name); console.log(`  ✗ ${name} ${extra}`); } };
const MB = 1024 * 1024;

// ── a real PNG of EXACTLY `total` bytes: random pixels (stored, so the size is predictable) plus a text chunk that makes up the difference
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
};
function png(total, W = 1000) {
  const rowLen = 1 + W * 3;
  const H = Math.max(1, Math.floor((total - 1000) / rowLen));
  const raw = randomBytes(H * rowLen).map((b) => b | 0x80);              // no ASCII marker can appear by chance
  for (let y = 0; y < H; y++) raw[y * rowLen] = 0;                       // filter type 0
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  const head = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 0 }))]);
  const end = chunk('IEND', Buffer.alloc(0));
  const room = total - head.length - end.length - 12 - 2;               // a tEXt chunk is 12 bytes of framing + "k\0" + the text
  if (room < 0) throw new Error('png(): target too small');
  const out = Buffer.concat([head, chunk('tEXt', Buffer.concat([Buffer.from('k\0'), Buffer.alloc(room, 0x61)])), end]);
  if (out.length !== total) throw new Error(`png(): ${out.length} != ${total}`);
  return out;
}

const bucket = () => { const m = new Map(); return { map: m, async put(k, v) { m.set(k, v); }, async delete(k) { for (const x of [].concat(k)) m.delete(x); }, async get(k) { return m.get(k) ?? null; } }; };
function build_({ plan = 'free', status = 'active', periodEnd = null, latency = 0 } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync('schema.sql', 'utf8'));
  const mk = (sql) => {
    let args = [];
    const wait = () => (latency ? new Promise((r) => setTimeout(r, latency)) : undefined);   // a real database is a network call away
    const st = { bind(...a) { args = a; return st; }, async first() { await wait(); return db.prepare(sql).get(...args) ?? null; }, async run() { await wait(); const r = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes) } }; }, async all() { await wait(); return { results: db.prepare(sql).all(...args) }; } };
    return st;
  };
  const env = { ENCRYPTION_KEY: 'k'.repeat(40), MODERATION_OFF: '1', MEDIA: bucket(), DB: { prepare: mk, async batch(stmts) { const out = []; for (const s of stmts) out.push(await s.run()); return out; } } };
  db.exec(`INSERT INTO users (id, email) VALUES ('u1', 'a@example.com')`);
  db.prepare(`INSERT INTO subscriptions (user_id, plan, status, current_period_end) VALUES ('u1', ?, ?, ?)`).run(plan, status, periodEnd);
  return { db, env };
}
// getSettings() remembers its answer for 15 s; saveSettings() clears that memory
async function fresh(opts = {}) { const f = build_(opts); await settings.saveSettings(f.env, { enforce_limits: opts.enforce ?? true }); return f; }

const cookie = async (env) => `${session.SESSION_COOKIE ?? 'vane_session'}=${await session.createSession(env, new Request('https://vaneapp.dev/'), 'u1')}`;
const headers = async (env) => ({ cookie: await cookie(env), origin: 'https://vaneapp.dev', 'sec-fetch-site': 'same-origin', 'cf-connecting-ip': '203.0.113.9' });
async function put(env, bytes, name = 'photo.png') {
  const fd = new FormData(); fd.append('file', new File([bytes], name, { type: 'image/png' }));
  const res = await upload.onRequestPost({ request: new Request('https://vaneapp.dev/api/media/upload', { method: 'POST', body: fd, headers: await headers(env) }), env, params: {}, waitUntil() {} });
  let data = null; try { data = await res.json(); } catch { /* */ }
  return { status: res.status, data };
}
async function usage(env) {
  const res = await list.onRequestGet({ request: new Request('https://vaneapp.dev/api/library/assets', { headers: await headers(env) }), env, params: {}, waitUntil() {} });
  return (await res.json()).usage;
}
async function onlyUsage(env, signedIn = true) {
  const res = await usageApi.onRequestGet({ request: new Request('https://vaneapp.dev/api/library/usage', { headers: signedIn ? await headers(env) : {} }), env, params: {}, waitUntil() {} });
  return { status: res.status, data: await res.json() };
}
async function remove(env, id) {
  const res = await one.onRequestDelete({ request: new Request(`https://vaneapp.dev/api/library/assets/${id}`, { method: 'DELETE', headers: await headers(env) }), env, params: { id }, waitUntil() {} });
  return res.status;
}
const stored = (db) => db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(size_bytes), 0) b FROM media_assets WHERE user_id = 'u1'`).get();

console.log('\nThe counter\'s own endpoint: GET /api/library/usage');
{
  const { env } = await fresh({ plan: 'free' });
  const empty = await onlyUsage(env);
  check('an empty library: 0 of 10 MB in 0 files', empty.status === 200 && empty.data.usage.usedBytes === 0 && empty.data.usage.count === 0 && empty.data.usage.limitBytes === 10 * MB && empty.data.usage.upgrade === true, JSON.stringify(empty));
  await put(env, png(3 * MB)); await put(env, png(2 * MB));
  const u2 = await onlyUsage(env);
  check('after two uploads: 5 MB in 2 files, and exactly what the file list reports', u2.data.usage.usedBytes === 5 * MB && u2.data.usage.count === 2 && JSON.stringify(u2.data.usage) === JSON.stringify(await usage(env)), JSON.stringify(u2));
  check('signed out: 401, no numbers', (await onlyUsage(env, false)).status === 401);
  const off = await fresh({ plan: 'free', enforce: false });
  { const o = (await onlyUsage(off.env)).data.usage; check('limits not enforced: the plan maximum is still shown, flagged as not enforced', o.limitBytes === 10 * MB && o.enforced === false); }
}

console.log('\nWhat each plan includes (the number the Library shows as the maximum)');
for (const [plan, mb] of [['free', 10], ['api', 100], ['pro', 100], ['suite', 100]]) {
  const { env } = await fresh({ plan });
  const u = await usage(env);
  check(`${plan}: ${mb} MB`, u.limitBytes === mb * MB, JSON.stringify(u));
}

console.log('\nFree Trial: 10 MB in total');
{
  const { db, env } = await fresh({ plan: 'free' });
  const a = await put(env, png(5 * MB)), b = await put(env, png(5 * MB));
  check('two 5 MB images fill it to exactly 10 MB and both are accepted', a.status === 201 && b.status === 201, JSON.stringify([a.status, a.data, b.status, b.data]));
  const u = await usage(env);
  check('the Library reports 10 MB of 10 MB in 2 files, and that a paid plan has more room', u.usedBytes === 10 * MB && u.limitBytes === 10 * MB && u.count === 2 && u.upgrade === true, JSON.stringify(u));
  const c = await put(env, png(4000, 40));
  check('even a tiny file is refused now: 402 that names the limit and the paid plans', c.status === 402 && /10 MB of library storage/.test(c.data.error) && /paid plan/.test(c.data.error), JSON.stringify(c));
  check('the refused file was neither stored nor recorded', stored(db).n === 2 && env.MEDIA.map.size === 2, JSON.stringify([stored(db), env.MEDIA.map.size]));
  const firstId = db.prepare(`SELECT id FROM media_assets WHERE user_id = 'u1' ORDER BY rowid LIMIT 1`).get().id;
  check('deleting a file answers 200', (await remove(env, firstId)) === 200);
  const d = await usage(env);
  check('the room comes back: 5 MB of 10 MB in 1 file', d.usedBytes === 5 * MB && d.count === 1, JSON.stringify(d));
  const e = await put(env, png(3 * MB));
  check('and a new file fits again', e.status === 201, JSON.stringify(e));
  const f = await put(env, png(3 * MB));
  check('8 MB used: a 3 MB file does not fit (11 MB), a 2 MB one would', f.status === 402 && (await put(env, png(2 * MB))).status === 201);
}

console.log('\nA paid plan: 100 MB in total');
{
  const { db, env } = await fresh({ plan: 'pro' });
  const one5 = png(5 * MB);
  let ok = 0;
  for (let i = 0; i < 20; i++) if ((await put(env, one5, `p${i}.png`)).status === 201) ok++;
  const u = await usage(env);
  check('twenty 5 MB images (100 MB) are all accepted, the Library says 100 MB of 100 MB in 20 files', ok === 20 && u.usedBytes === 100 * MB && u.limitBytes === 100 * MB && u.count === 20 && u.upgrade === false, JSON.stringify([ok, u]));
  const x = await put(env, png(4000, 40));
  check('the next file is refused: 402 that names 100 MB and does not push to a paid plan', x.status === 402 && /100 MB of library storage/.test(x.data.error) && !/paid plan/.test(x.data.error), JSON.stringify(x));
  check('nothing extra was stored', stored(db).n === 20 && env.MEDIA.map.size === 20);
}

console.log('\nWhile "enforce_limits" is off (the default) there is no limit');
{
  const { env } = await fresh({ plan: 'free', enforce: false });
  const u0 = await usage(env);
  check('the Library shows the plan maximum but says it is not enforced', u0.limitBytes === 10 * MB && u0.enforced === false, JSON.stringify(u0));
  let ok = 0;
  for (let i = 0; i < 3; i++) if ((await put(env, png(5 * MB))).status === 201) ok++;
  check('15 MB goes into a Free Trial library', ok === 3 && (await usage(env)).usedBytes === 15 * MB);
}

console.log('\nA paid plan that ran out falls back to the Free Trial limit');
{
  const { env } = await fresh({ plan: 'pro', status: 'active', periodEnd: Math.floor(Date.now() / 1000) - 86400 });
  const u = await usage(env);
  check('a lapsed Pro has 10 MB, like a Free Trial', u.limitBytes === 10 * MB && u.upgrade === true, JSON.stringify(u));
}

console.log('\nUploads at the same moment (the database answers with a delay, like D1 does)');
{
  const { db, env } = await fresh({ plan: 'free', latency: 8 });
  await put(env, png(5 * MB)); await put(env, png(1 * MB));            // 6 MB used, 4 MB free
  const [p, q] = await Promise.all([put(env, png(3 * MB)), put(env, png(3 * MB))]);
  const t = stored(db);
  check('two 3 MB files that each fit alone: exactly one is kept, the other gets 402', [p.status, q.status].sort().join() === '201,402', `statuses ${p.status}/${q.status}`);
  check('the library stays within 10 MB (9 MB)', t.b <= 10 * MB && t.b === 9 * MB && t.n === 3, `${t.n} files, ${(t.b / MB).toFixed(1)} MB`);
  check('the refused one left nothing behind in storage', env.MEDIA.map.size === t.n, `${env.MEDIA.map.size} objects for ${t.n} rows`);
  const three = await Promise.all([put(env, png(1 * MB)), put(env, png(1 * MB)), put(env, png(1 * MB))]);
  const u = await usage(env);
  check('three 1 MB files at once with 1 MB of room: one is kept', three.filter((x) => x.status === 201).length === 1 && u.usedBytes === 10 * MB, JSON.stringify([three.map((x) => x.status), u]));
}
{
  const { db, env } = await fresh({ plan: 'free', latency: 8 });
  const five = await Promise.all([1, 2, 3, 4, 5].map(() => put(env, png(5 * MB))));
  const t = stored(db);
  check('five 5 MB files at once into an empty Free Trial: two are kept (10 MB), three get 402', five.filter((x) => x.status === 201).length === 2 && five.filter((x) => x.status === 402).length === 3 && t.b === 10 * MB, JSON.stringify([five.map((x) => x.status), t]));
  check('and storage holds exactly the two that were kept', env.MEDIA.map.size === 2 && t.n === 2);
}

console.log('\nA limit set for one account');
{
  const { env, db } = await fresh({ plan: 'free' });
  db.prepare(`INSERT INTO user_storage_limits (user_id, storage_mb) VALUES ('u1', 3)`).run();
  const u = (await onlyUsage(env)).data.usage;
  check('the account allowance replaces the plan limit (3 MB instead of 10)', u.limitBytes === 3 * MB && u.enforced === true, JSON.stringify(u));
  check('a 2 MB file fits', (await put(env, png(2 * MB))).status === 201);
  check('a second 2 MB file does not (402)', (await put(env, png(2 * MB))).status === 402);
  db.prepare(`UPDATE user_storage_limits SET storage_mb = 50`).run();
  check('a bigger allowance than the plan is possible', (await put(env, png(2 * MB))).status === 201 && (await onlyUsage(env)).data.usage.limitBytes === 50 * MB);
  db.prepare(`DELETE FROM user_storage_limits`).run();
  check('without a row the plan limit applies again', (await onlyUsage(env)).data.usage.limitBytes === 10 * MB);
  db.exec('DROP TABLE user_storage_limits');
  check('before the migration the plan limit is used, nothing breaks', (await onlyUsage(env)).data.usage.limitBytes === 10 * MB);
}

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
