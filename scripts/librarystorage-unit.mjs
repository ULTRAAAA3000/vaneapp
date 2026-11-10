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
  `export * as storage from '${root}/worker/src/storage.ts';`,
  `export * as plansApi from '${root}/functions/api/admin/plans.ts';`,
  `export * as plans from '${root}/functions/api/lib/plans.ts';`,
].join('\n'));
const adminStub = { name: 'admin-stub', setup(b) {
  b.onResolve({ filter: /lib\/admin$/ }, () => ({ path: 'admin-stub', namespace: 'stub' }));
  b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const requireAdmin = async () => ({ ok: true, adminId: "a" }); export const audit = async () => {};', loader: 'js' }));
} };
await build({ entryPoints: [join(dir, 'entry.ts')], bundle: true, format: 'esm', platform: 'node', outfile: join(dir, 'all.mjs'), logLevel: 'silent', plugins: [adminStub] });
const { upload, list, one, usageApi, session, settings, storage, plansApi, plans } = await import(pathToFileURL(join(dir, 'all.mjs')).href);
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
// getSettings() and the plan table are remembered for 15 s per isolate; saveSettings() and invalidatePlanSpecs() clear that memory, so every scenario starts clean
async function fresh(opts = {}) { plans.invalidatePlanSpecs(); const f = build_(opts); await settings.saveSettings(f.env, { enforce_limits: opts.enforce ?? true }); return f; }

const cookie = async (env, uid = 'u1') => `${session.SESSION_COOKIE ?? 'vane_session'}=${await session.createSession(env, new Request('https://vaneapp.dev/'), uid)}`;
const headers = async (env, uid = 'u1') => ({ cookie: await cookie(env, uid), origin: 'https://vaneapp.dev', 'sec-fetch-site': 'same-origin', 'cf-connecting-ip': '203.0.113.9' });
async function put(env, bytes, name = 'photo.png', uid = 'u1') {
  const fd = new FormData(); fd.append('file', new File([bytes], name, { type: 'image/png' }));
  const res = await upload.onRequestPost({ request: new Request('https://vaneapp.dev/api/media/upload', { method: 'POST', body: fd, headers: await headers(env, uid) }), env, params: {}, waitUntil() {} });
  let data = null; try { data = await res.json(); } catch { /* */ }
  return { status: res.status, data };
}
async function usage(env) {
  const res = await list.onRequestGet({ request: new Request('https://vaneapp.dev/api/library/assets', { headers: await headers(env) }), env, params: {}, waitUntil() {} });
  return (await res.json()).usage;
}
async function onlyUsage(env, signedIn = true, uid = 'u1') {
  const res = await usageApi.onRequestGet({ request: new Request('https://vaneapp.dev/api/library/usage', { headers: signedIn ? await headers(env, uid) : {} }), env, params: {}, waitUntil() {} });
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

console.log('\nOver the allowance: 3 days to clean up, then the newest uploads go');
{
  const { env, db } = await fresh({ plan: 'free' });
  await put(env, png(4 * MB)); await put(env, png(3 * MB)); await put(env, png(3 * MB));
  const t0 = Math.floor(Date.now() / 1000);
  check('exactly at the limit: no warning', (await onlyUsage(env)).data.usage.over === null);
  db.prepare(`INSERT INTO user_storage_limits (user_id, storage_mb) VALUES ('u1', 6)`).run();
  const o = (await onlyUsage(env)).data.usage;
  check('over the new limit: the warning carries a deadline 3 days away', o.over && Math.abs(o.over.deadline - (t0 + 3 * 86400)) < 5 && o.limitBytes === 6 * MB, JSON.stringify(o));
  const since = db.prepare('SELECT since FROM storage_overages').get().since;
  await (async () => { await onlyUsage(env); })();
  check('asking again keeps the same start day', db.prepare('SELECT since FROM storage_overages').get().since === since);
  const r1 = await storage.runStoragePurge(env, since + 86400);
  check('after 1 day nothing is removed', r1.removed === 0 && stored(db).n === 3, JSON.stringify(r1));
  const r2 = await storage.runStoragePurge(env, since + 3 * 86400 + 60);
  const left = stored(db);
  check('after 3 days the newest file goes, until the rest fits (4 + 3 = 7 > 6, so two go: 4 stay)', r2.removed === 2 && left.n === 1 && left.b === 4 * MB, JSON.stringify([r2, left]));
  check('the oldest upload is the one that stays', db.prepare('SELECT size_bytes FROM media_assets').get().size_bytes === 4 * MB);
  check('the files are gone from storage too', env.MEDIA.map.size === 1);
  check('the warning is gone', db.prepare('SELECT COUNT(*) n FROM storage_overages').get().n === 0 && (await onlyUsage(env)).data.usage.over === null);
}
{
  const { env, db } = await fresh({ plan: 'free' });
  await put(env, png(5 * MB));
  db.prepare(`INSERT INTO user_storage_limits (user_id, storage_mb) VALUES ('u1', 2)`).run();
  await onlyUsage(env);
  const id = db.prepare('SELECT id FROM media_assets').get().id;
  await remove(env, id);
  check('deleting the file yourself clears the warning', (await onlyUsage(env)).data.usage.over === null && db.prepare('SELECT COUNT(*) n FROM storage_overages').get().n === 0);
}
{
  const { env, db } = await fresh({ plan: 'free', enforce: false });
  await put(env, png(5 * MB));
  db.prepare(`INSERT INTO user_storage_limits (user_id, storage_mb) VALUES ('u1', 2)`).run();
  check('limits not enforced: no warning', (await onlyUsage(env)).data.usage.over === null && db.prepare('SELECT COUNT(*) n FROM storage_overages').get().n === 0);
  db.prepare(`INSERT INTO storage_overages (user_id, since) VALUES ('u1', 1)`).run();
  const r = await storage.runStoragePurge(env, 10 * 86400);
  check('limits not enforced: nothing is removed and old marks are dropped', r.removed === 0 && stored(db).n === 1 && db.prepare('SELECT COUNT(*) n FROM storage_overages').get().n === 0);
}
{
  const { env, db } = await fresh({ plan: 'free' });
  await put(env, png(5 * MB));
  db.prepare(`INSERT INTO user_storage_limits (user_id, storage_mb) VALUES ('u1', 2)`).run();
  const r = await storage.runStoragePurge(env, Math.floor(Date.now() / 1000));
  check('the hourly scan finds an account that is over, without it opening the dashboard', r.marked === 1 && db.prepare('SELECT COUNT(*) n FROM storage_overages').get().n === 1);
}
{
  const { env, db } = await fresh({ plan: 'free' });
  db.exec('DROP TABLE storage_overages');
  await put(env, png(5 * MB));
  db.prepare(`INSERT INTO user_storage_limits (user_id, storage_mb) VALUES ('u1', 2)`).run();
  check('before the migration: no warning and nothing breaks', (await onlyUsage(env)).data.usage.over === null && (await storage.runStoragePurge(env, 10 * 86400)).removed === 0 && stored(db).n === 1);
}

console.log('\nA plan with no storage value of its own (the admin left the field empty)');
{
  const { env, db } = await fresh({ plan: 'pro' });
  db.exec(`INSERT INTO plans (id, kind, name, limits, price_cents, is_active, interval) VALUES ('pro', 'plan', 'Pro', '{"postsPerMonth":1000}', 1199, 1, 'month') ON CONFLICT(id) DO UPDATE SET limits = excluded.limits`);
  const u = (await onlyUsage(env)).data.usage;
  check('falls back to the built-in 100 MB, not unlimited', u.limitBytes === 100 * MB, JSON.stringify(u));
}

// ── the admin sets how much a plan may hold (Admin -> Plans -> "Library storage, MB"), on the real PUT /api/admin/plans
function addAccount(db, id, plan) {
  db.prepare(`INSERT INTO users (id, email) VALUES (?, ?)`).run(id, `${id}@example.com`);
  db.prepare(`INSERT INTO subscriptions (user_id, plan, status) VALUES (?, ?, 'active')`).run(id, plan);
}
async function setPlanMb(env, db, planId, mb) {       // like the editor: all the limits of the plan go back, with this one changed
  const limits = JSON.parse(db.prepare('SELECT limits FROM plans WHERE id = ?').get(planId).limits);
  if (mb === undefined) delete limits.storageMb; else limits.storageMb = mb;
  const res = await plansApi.onRequestPut({ request: new Request(`https://vaneapp.dev/api/admin/plans?id=${planId}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ limits }) }), env, params: {}, waitUntil() {} });
  let data = null; try { data = await res.json(); } catch { /* */ }
  return { status: res.status, data };
}
const lim = async (env, uid) => (await onlyUsage(env, true, uid)).data.usage;

console.log('\nThe admin changes a plan: the bar moves for every account on it, and only on it');
{
  const { env, db } = await fresh({ plan: 'free' });
  addAccount(db, 'u2', 'free'); addAccount(db, 'u3', 'pro');
  await put(env, png(4 * MB), 'a.png', 'u1'); await put(env, png(3 * MB), 'b.png', 'u1'); await put(env, png(1 * MB), 'c.png', 'u1');   // u1: 8 MB, newest = c
  await put(env, png(2 * MB), 'd.png', 'u2');                                                                                            // u2: 2 MB
  await put(env, png(5 * MB), 'e.png', 'u3');                                                                                            // u3 (Pro): 5 MB
  const before = [(await lim(env, 'u1')).limitBytes, (await lim(env, 'u2')).limitBytes, (await lim(env, 'u3')).limitBytes];
  check('to begin with: Free 10 MB, Pro 100 MB', JSON.stringify(before) === JSON.stringify([10 * MB, 10 * MB, 100 * MB]), JSON.stringify(before));
  const r = await setPlanMb(env, db, 'free', 5);
  check('the admin saves Free at 5 MB: 200', r.status === 200, JSON.stringify(r));
  const a = await lim(env, 'u1'), b = await lim(env, 'u2'), c = await lim(env, 'u3');
  check('the bar moves at once for the Free accounts (5 MB) and not for Pro (100 MB)', a.limitBytes === 5 * MB && b.limitBytes === 5 * MB && c.limitBytes === 100 * MB, JSON.stringify([a.limitBytes, b.limitBytes, c.limitBytes]));
  check('the account that holds 8 MB gets the red warning with a deadline 3 days away; the others do not', a.over && Math.abs(a.over.deadline - (Math.floor(Date.now() / 1000) + 3 * 86400)) < 5 && b.over === null && c.over === null, JSON.stringify([a.over, b.over, c.over]));
  check('and cannot add a file until it is under 5 MB', (await put(env, png(4000, 40), 'x.png', 'u1')).status === 402 && (await put(env, png(2 * MB), 'y.png', 'u2')).status === 201);
  const t0 = db.prepare(`SELECT since FROM storage_overages WHERE user_id = 'u1'`).get().since;
  await storage.runStoragePurge(env, t0 + 86400);
  check('the hourly job after 1 day removes nothing', stored(db).n === 3);
  const p = await storage.runStoragePurge(env, t0 + 3 * 86400 + 60);
  check('after 3 days the newest uploads go until 5 MB fits: c (1 MB) and b (3 MB) leave, a (4 MB) stays', p.removed === 2 && stored(db).b === 4 * MB && db.prepare(`SELECT name FROM media_assets WHERE user_id = 'u1'`).get().name === 'a.png', JSON.stringify([p, stored(db)]));
  check('Pro and the other Free account lose nothing', db.prepare(`SELECT COUNT(*) n FROM media_assets WHERE user_id IN ('u2', 'u3')`).get().n === 3);
}
{
  const { env, db } = await fresh({ plan: 'free' });
  addAccount(db, 'u3', 'pro');
  await put(env, png(4 * MB), 'a.png', 'u1'); await put(env, png(4 * MB), 'b.png', 'u1');
  await setPlanMb(env, db, 'free', 6);
  check('8 MB on a 6 MB plan: warned', (await lim(env, 'u1')).over !== null);
  await setPlanMb(env, db, 'free', 20);
  const raised = await lim(env, 'u1');
  check('the admin raises Free to 20 MB: the bar follows and the warning is gone', raised.limitBytes === 20 * MB && raised.over === null && db.prepare('SELECT COUNT(*) n FROM storage_overages').get().n === 0, JSON.stringify(raised));
  await setPlanMb(env, db, 'free', undefined);
  check('the admin empties the field: back to the built-in 10 MB, not unlimited', (await lim(env, 'u1')).limitBytes === 10 * MB);
  await setPlanMb(env, db, 'pro', 50);
  check('Pro Dashboard has its own number: 50 MB', (await lim(env, 'u3')).limitBytes === 50 * MB);
  check('a limit that is not a whole number or below zero is refused (400)', (await setPlanMb(env, db, 'free', 1.5)).status === 400 && (await setPlanMb(env, db, 'free', -3)).status === 400 && (await setPlanMb(env, db, 'free', 'lots')).status === 400);
  check('and the plan keeps its last good value', (await lim(env, 'u1')).limitBytes === 10 * MB);
}
{
  const { env, db } = await fresh({ plan: 'free', enforce: false });
  await put(env, png(5 * MB)); await put(env, png(5 * MB)); await put(env, png(3 * MB));
  await setPlanMb(env, db, 'free', 2);
  const u = await lim(env, 'u1');
  check('limits not enforced yet (today\'s production): the plan maximum is shown, no red warning, nothing is removed', u.limitBytes === 2 * MB && u.enforced === false && u.over === null && (await storage.runStoragePurge(env, 10 * 86400)).removed === 0 && stored(db).n === 3, JSON.stringify(u));
}
{
  const { env, db } = await fresh({ plan: 'free' });
  await put(env, png(3 * MB));
  await setPlanMb(env, db, 'free', 0);
  const u = await lim(env, 'u1');
  check('a plan of 0 MB is a limit, not "no limit": the account is over from the first byte and is warned', u.limitBytes === 0 && u.enforced === true && u.over !== null, JSON.stringify(u));
  check('nothing can be uploaded on it', (await put(env, png(4000, 40))).status === 402);
}

console.log('\nThe hourly clean-up: one account that fails does not stop the others');
{
  const { env, db } = await fresh({ plan: 'free' });
  addAccount(db, 'u2', 'free');
  const row = (id, uid, key, mb, at) => { db.prepare(`INSERT INTO media_assets (id, user_id, r2_key, kind, content_type, size_bytes, name, created_at) VALUES (?, ?, ?, 'image', 'image/png', ?, ?, ?)`).run(id, uid, key, mb * MB, key, at); env.MEDIA.map.set(key, new Uint8Array(1)); };
  row('1', 'u1', 'bad-1.png', 6, 100); row('2', 'u1', 'bad-2.png', 6, 200);        // u1 holds 12 MB; its storage refuses to delete
  row('3', 'u2', 'ok-1.png', 6, 100); row('4', 'u2', 'ok-2.png', 6, 200);          // u2 holds 12 MB too
  const realDelete = env.MEDIA.delete.bind(env.MEDIA);
  env.MEDIA.delete = async (k) => { if (String([].concat(k)[0]).startsWith('bad-')) throw new Error('storage unavailable'); return realDelete(k); };
  const t = Math.floor(Date.now() / 1000);
  await storage.runStoragePurge(env, t);
  const logged = console.error; console.error = () => {};
  let threw = false, res = null;
  try { res = await storage.runStoragePurge(env, t + 3 * 86400 + 60); } catch { threw = true; }
  console.error = logged;
  check('the job does not stop', threw === false);
  check('the other account is cleaned up anyway (its newest file goes, 6 MB stay)', db.prepare(`SELECT COUNT(*) n FROM media_assets WHERE user_id = 'u2'`).get().n === 1 && db.prepare(`SELECT name FROM media_assets WHERE user_id = 'u2'`).get().name === 'ok-1.png', JSON.stringify(res));
  check('the failing account keeps its files and its clock, so it is tried again next hour', db.prepare(`SELECT COUNT(*) n FROM media_assets WHERE user_id = 'u1'`).get().n === 2 && db.prepare(`SELECT COUNT(*) n FROM storage_overages WHERE user_id = 'u1'`).get().n === 1);
}

console.log('\nOnly Free, Pro, Studio and Suite have their own storage; every other plan follows Pro');
{
  const { env, db } = await fresh({ plan: 'free' });
  addAccount(db, 'u4', 'api'); addAccount(db, 'u5', 'suite'); addAccount(db, 'u6', 'pro');
  check('the Developer API plan starts at Pro\'s 100 MB', (await lim(env, 'u4')).limitBytes === 100 * MB);
  await setPlanMb(env, db, 'suite', undefined);
  await setPlanMb(env, db, 'pro', 250);
  check('Pro at 250 MB: Pro, the Developer API plan and a Suite without a value of its own all move to 250', (await lim(env, 'u6')).limitBytes === 250 * MB && (await lim(env, 'u4')).limitBytes === 250 * MB && (await lim(env, 'u5')).limitBytes === 250 * MB);
  await setPlanMb(env, db, 'api', 7);
  check('a value saved on the Developer API plan is ignored: it still follows Pro', (await lim(env, 'u4')).limitBytes === 250 * MB);
  await setPlanMb(env, db, 'suite', 400);
  check('the Suite with its own value uses it (400 MB), Pro stays at 250', (await lim(env, 'u5')).limitBytes === 400 * MB && (await lim(env, 'u6')).limitBytes === 250 * MB);
  await setPlanMb(env, db, 'pro', undefined);
  check('Pro with the field emptied is back to 100 MB, and the Developer API plan with it', (await lim(env, 'u6')).limitBytes === 100 * MB && (await lim(env, 'u4')).limitBytes === 100 * MB);
  await setPlanMb(env, db, 'free', undefined);
  check('Free with the field emptied is 10 MB', (await lim(env, 'u1')).limitBytes === 10 * MB);
}

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
