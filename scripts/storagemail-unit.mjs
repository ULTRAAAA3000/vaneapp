#!/usr/bin/env node
/**
 * The emails about a library over its plan (worker/src/storage.ts + lib/storagemail.ts), on the REAL clean-up and schema.sql
 * (in-memory SQLite, a fake R2 bucket, Resend replaced by a fetch that records what would be sent).   npm run test:unit
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
  `export * as storage from '${root}/worker/src/storage.ts';`,
  `export * as mail from '${root}/functions/api/lib/storagemail.ts';`,
  `export * as settings from '${root}/functions/api/lib/settings.ts';`,
  `export * as plans from '${root}/functions/api/lib/plans.ts';`,
].join('\n'));
await build({ entryPoints: [join(dir, 'entry.ts')], bundle: true, format: 'esm', platform: 'node', outfile: join(dir, 'all.mjs'), logLevel: 'silent' });
const { storage, mail, settings, plans } = await import(pathToFileURL(join(dir, 'all.mjs')).href);
rmSync(dir, { recursive: true, force: true });

let passed = 0;
const failed = [];
const check = (name, cond, extra = '') => { if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed.push(name); console.log(`  ✗ ${name} ${extra}`); } };
const MB = 1024 * 1024, DAY = 86400, T0 = 1_800_000_000;

// every call to Resend lands here; `answer` decides what Resend says
const sent = [];
let answer = () => new Response('{"id":"m1"}', { status: 200 });
globalThis.fetch = async (url, init) => { const body = JSON.parse(init.body); sent.push({ url: String(url), to: body.to[0], subject: body.subject, text: body.text, html: body.html, headers: body.headers }); return answer(); };

const bucket = () => { const m = new Map(); return { map: m, async put(k, v) { m.set(k, v); }, async delete(k) { for (const x of [].concat(k)) m.delete(x); }, async get(k) { return m.get(k) ?? null; } }; };
async function scenario({ plan = 'free', email = true, enforce = true } = {}) {
  plans.invalidatePlanSpecs();
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync('schema.sql', 'utf8'));
  const latency = 0;
  const mk = (sql) => {
    let args = [];
    const wait = () => (latency ? new Promise((r) => setTimeout(r, latency)) : undefined);   // a real database is a network call away
    const st = { bind(...a) { args = a; return st; }, async first() { await wait(); return db.prepare(sql).get(...args) ?? null; }, async run() { await wait(); const r = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes) } }; }, async all() { await wait(); return { results: db.prepare(sql).all(...args) }; } };
    return st;
  };
  const env = { ENCRYPTION_KEY: 'k'.repeat(40), MEDIA: bucket(), APP_URL: 'https://vaneapp.dev/', DB: { prepare: mk, async batch(stmts) { const out = []; for (const s of stmts) out.push(await s.run()); return out; } }, ...(email ? { RESEND_API_KEY: 're_test', EMAIL_FROM: 'Vane <noreply@vaneapp.dev>' } : {}) };
  db.exec(`INSERT INTO users (id, email) VALUES ('u1', 'ann@example.com')`);
  db.prepare(`INSERT INTO subscriptions (user_id, plan, status) VALUES ('u1', ?, 'active')`).run(plan);
  await settings.saveSettings(env, { enforce_limits: enforce });
  sent.length = 0; answer = () => new Response('{"id":"m1"}', { status: 200 });
  return { db, env };
}
let n = 0;
const file = (db, env, mb, createdAt) => { n++; const key = `u1/f${n}.png`; env.MEDIA.map.set(key, 1); db.prepare(`INSERT INTO media_assets (id, user_id, r2_key, kind, content_type, size_bytes, name, created_at) VALUES (?1, 'u1', ?2, 'image', 'image/png', ?3, ?4, ?5)`).run(`a${n}`, key, mb * MB, `f${n}.png`, createdAt); };
const logs = (db, event) => db.prepare('SELECT COUNT(*) n FROM logs WHERE event = ?1').get(event).n;
const files = (db) => db.prepare('SELECT COUNT(*) n FROM media_assets').get().n;

console.log('\nlibrary over plan: the first email');
{
  const { db, env } = await scenario();          // Free Trial: 10 MB
  file(db, env, 6, T0 - 50); file(db, env, 6, T0 - 40);   // 12 MB
  const r = await storage.runStoragePurge(env, T0);
  check('the hour the account goes over, one email is sent', r.mailed === 1 && sent.length === 1, JSON.stringify([r, sent.length]));
  const m = sent[0];
  check('it goes through Resend to the account address', m.url.includes('api.resend.com') && m.to === 'ann@example.com');
  check('the subject says what happened', m.subject === 'Your Vane library is over your plan');
  check('the text has the sizes, the plan and the deadline 3 days away', /uses 12 MB/.test(m.text) && /Free Trial plan includes 10 MB \(2 MB over\)/.test(m.text) && m.text.includes(new Date((T0 + 3 * DAY) * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'), m.text);
  check('it links to the library and to the plans, on the configured origin without a double slash', m.text.includes('https://vaneapp.dev/app#library') && m.text.includes('https://vaneapp.dev/pricing') && !m.html.includes('dev//'));
  check('it says the newest uploads go first and that scheduled posts keep their files', /newest uploads first/.test(m.text) && /still scheduled stay/.test(m.text));
  check('it explains why it came even to someone who unsubscribed, and has no unsubscribe footer', /even if you unsubscribed/.test(m.text) && !/Unsubscribe from Vane emails/.test(m.text) && !m.headers);
  check('nothing is removed yet', files(db) === 2);
  check('the send is logged once', logs(db, mail.OVER_EVENT) === 1);
  const again = await storage.runStoragePurge(env, T0 + 3600);
  check('the next hourly run sends nothing more', again.mailed === 0 && sent.length === 1);
  await storage.runStoragePurge(env, T0 + 12 * 3600);
  check('half a day later: still nothing more', sent.length === 1);
}

console.log('\nthe last-24-hours reminder');
{
  const { db, env } = await scenario();
  file(db, env, 6, T0 - 50); file(db, env, 6, T0 - 40);
  await storage.runStoragePurge(env, T0);
  const before = sent.length;
  await storage.runStoragePurge(env, T0 + 2 * DAY - 3600);   // 25 hours left
  check('with 25 hours left there is no reminder yet', sent.length === before);
  const r = await storage.runStoragePurge(env, T0 + 2 * DAY + 3 * 3600);   // 21 hours left
  check('with less than 24 hours left (21) the reminder goes out', r.mailed === 1 && sent.length === before + 1 && /Last day/.test(sent[sent.length - 1].subject), JSON.stringify(sent.map((x) => x.subject)));
  check('the reminder counts the hours and repeats the deadline', /About 21 hours left/.test(sent[sent.length - 1].text), sent[sent.length - 1].text);
  await storage.runStoragePurge(env, T0 + 2 * DAY + 4 * 3600); await storage.runStoragePurge(env, T0 + 2 * DAY + 5 * 3600);
  check('it is sent once, not every hour', sent.length === before + 1 && logs(db, mail.REMIND_EVENT) === 1);
  check('nothing is removed before the deadline', files(db) === 2);
}

console.log('\nan account that is only noticed in its last day');
{
  const { db, env } = await scenario();
  file(db, env, 6, T0 - 50); file(db, env, 6, T0 - 40);
  db.prepare('INSERT INTO storage_overages (user_id, since) VALUES (?1, ?2)').run('u1', T0);   // went over at T0, but no email has been sent
  const r = await storage.runStoragePurge(env, T0 + 2 * DAY + 5 * 3600);
  check('one email, the reminder (it says everything), not two', r.mailed === 1 && sent.length === 1 && /Last day/.test(sent[0].subject), JSON.stringify(sent.map((x) => x.subject)));
  check('both are marked as sent, so the first one never follows', logs(db, mail.OVER_EVENT) === 1 && logs(db, mail.REMIND_EVENT) === 1);
  await storage.runStoragePurge(env, T0 + 2 * DAY + 6 * 3600);
  check('no second email an hour later', sent.length === 1);
}

console.log('\nafter the deadline');
{
  const { db, env } = await scenario();
  file(db, env, 6, T0 - 50); file(db, env, 6, T0 - 40);
  await storage.runStoragePurge(env, T0);
  sent.length = 0;
  const r = await storage.runStoragePurge(env, T0 + 3 * DAY + 60);
  check('the newest file is removed so the rest fits', r.removed === 1 && files(db) === 1);
  const m = sent[sent.length - 1];
  check('an email says how many files were removed', r.mailed === 1 && m && /removed 1 file, newest first/.test(m.text) && m.subject === 'Vane removed 1 file from your library', JSON.stringify(sent.map((x) => x.subject)));
  check('the account is no longer marked as over', db.prepare('SELECT COUNT(*) n FROM storage_overages').get().n === 0);
  check('a removal is logged', logs(db, mail.REMOVED_EVENT) === 1);
}

console.log('\na new overage later gets its own emails');
{
  const { db, env } = await scenario();
  file(db, env, 6, T0 - 50); file(db, env, 6, T0 - 40);
  await storage.runStoragePurge(env, T0);
  db.prepare(`DELETE FROM media_assets WHERE name = 'f2.png'`).run().changes;   // back under the limit by itself
  db.prepare(`DELETE FROM media_assets`).run(); file(db, env, 4, T0);
  await storage.runStoragePurge(env, T0 + DAY);
  check('back under the limit: the mark is gone', db.prepare('SELECT COUNT(*) n FROM storage_overages').get().n === 0);
  sent.length = 0;
  file(db, env, 8, T0 + DAY + 10);   // 12 MB again
  const r = await storage.runStoragePurge(env, T0 + 5 * DAY);
  check('the second time over starts from zero: a new first email', r.mailed === 1 && sent.length === 1 && sent[0].subject === 'Your Vane library is over your plan', JSON.stringify(sent.map((x) => x.subject)));
}

console.log('\nwhen nothing can or should be sent');
{
  const a = await scenario({ email: false });
  file(a.db, a.env, 6, T0 - 50); file(a.db, a.env, 6, T0 - 40);
  const r = await storage.runStoragePurge(a.env, T0);
  check('Resend not configured: no email, no error, the 3 days still count', r.mailed === 0 && sent.length === 0 && r.marked === 1 && a.db.prepare('SELECT COUNT(*) n FROM storage_overages').get().n === 1);
  const b = await scenario({ enforce: false });
  file(b.db, b.env, 6, T0 - 50); file(b.db, b.env, 6, T0 - 40);
  const rb = await storage.runStoragePurge(b.env, T0);
  check('limits not enforced: no email', rb.mailed === 0 && sent.length === 0);
  const c = await scenario();
  file(c.db, c.env, 4, T0 - 50); file(c.db, c.env, 4, T0 - 40);
  const rc = await storage.runStoragePurge(c.env, T0);
  check('inside the plan: no email', rc.mailed === 0 && sent.length === 0);
  const d = await scenario();
  file(d.db, d.env, 6, T0 - 50); file(d.db, d.env, 6, T0 - 40);
  d.db.prepare(`UPDATE users SET email = '' WHERE id = 'u1'`).run();
  const rd = await storage.runStoragePurge(d.env, T0);
  check('an account without an address: skipped quietly', rd.mailed === 0 && sent.length === 0 && rd.marked === 1);
}
{
  const { db, env } = await scenario();
  file(db, env, 6, T0 - 50); file(db, env, 6, T0 - 40);
  answer = () => new Response('{"name":"validation_error","message":"bad"}', { status: 422 });
  const bad = await storage.runStoragePurge(env, T0);
  check('Resend refuses: nothing is logged and nothing throws', bad.mailed === 0 && logs(db, mail.OVER_EVENT) === 0);
  answer = () => new Response('{"id":"m2"}', { status: 200 });
  const ok = await storage.runStoragePurge(env, T0 + 3600);
  check('the next hour it is tried again and goes out', ok.mailed === 1 && logs(db, mail.OVER_EVENT) === 1);
}

console.log('\nthe mail text');
{
  const c = { planLabel: 'Pro <b>', usedBytes: 120 * MB, limitBytes: 100 * MB, deadline: T0, origin: 'https://vaneapp.dev' };
  check('sizes: one decimal below 100 MB, none above', mail.fmtMb(9.44 * MB) === '9.4 MB' && mail.fmtMb(103.4 * MB) === '103 MB' && mail.fmtMb(0) === '0 MB');
  const m = mail.overMail('x@example.com', c);
  check('values that go into the HTML are escaped', !m.html.includes('<b>') && m.html.includes('Pro &lt;b&gt;'));
  check('service message: sent to opted-out people too, no footer', m.optional === false && m.unsubscribe === false);
  const r = mail.removedMail('x@example.com', { ...c, removed: 3 });
  check('plurals: 3 files / 1 file', /3 files/.test(r.subject) && /1 file\b/.test(mail.removedMail('x@example.com', { ...c, removed: 1 }).subject));
  const k = mail.remindMail('x@example.com', { ...c, deadline: T0 + 90 * 60 }, T0);
  check('the reminder never says "0 hours"', /About 2 hours left|About 1 hour left/.test(k.text), k.text);
}

console.log(`\n${passed} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
