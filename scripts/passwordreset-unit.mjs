#!/usr/bin/env node
/**
 * "Forgot password?" end to end on the REAL handlers (/api/auth/forgot, /api/auth/reset, /api/auth/login) and the REAL schema.sql
 * (in-memory SQLite), with the emails captured instead of sent.   npm run test:unit
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
  `export * as forgot from '${root}/functions/api/auth/forgot.ts';`,
  `export * as reset from '${root}/functions/api/auth/reset.ts';`,
  `export * as login from '${root}/functions/api/auth/login.ts';`,
  `export * as password from '${root}/functions/api/lib/password.ts';`,
  `export * as session from '${root}/functions/api/lib/session.ts';`,
  `export * as emailcode from '${root}/functions/api/lib/emailcode.ts';`,
].join('\n'));
await build({ entryPoints: [join(dir, 'entry.ts')], bundle: true, format: 'esm', platform: 'node', outfile: join(dir, 'all.mjs'), logLevel: 'silent' });
const { forgot, reset, login, password, session, emailcode } = await import(pathToFileURL(join(dir, 'all.mjs')).href);
rmSync(dir, { recursive: true, force: true });

let passed = 0;
const failed = [];
const check = (name, cond, extra = '') => { if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed.push(name); console.log(`  ✗ ${name} ${extra}`); } };

const mails = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).includes('resend.com')) { mails.push(JSON.parse(init.body)); return new Response(JSON.stringify({ id: 'x' }), { status: 200 }); }
  return realFetch(url, init);
};
const codeOf = (m) => /\b(\d{6})\b/.exec(m.text)?.[1];
const lastMail = () => mails[mails.length - 1];
const toOf = (m) => [].concat(m.to).join(',');   // Resend takes a list

async function fresh({ email = true } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync('schema.sql', 'utf8'));
  const mk = (sql) => {
    let args = [];
    const st = {
      bind(...a) { args = a; return st; },
      async first() { return db.prepare(sql).get(...args) ?? null; },
      async run() { const r = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes) } }; },
      async all() { return { results: db.prepare(sql).all(...args) }; },
    };
    return st;
  };
  const env = {
    JWT_SECRET: 'j'.repeat(40), ENCRYPTION_KEY: 'k'.repeat(40),
    ...(email ? { RESEND_API_KEY: 're_test', EMAIL_FROM: 'Vane <no-reply@vaneapp.dev>' } : {}),
    DB: { prepare: mk, async batch(stmts) {
      db.exec('BEGIN');
      try { const out = []; for (const s of stmts) out.push(await s.run()); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; }
    } },
  };
  const hash = await password.hashPassword('old-password-1');
  db.prepare(`INSERT INTO users (id, email, password_hash) VALUES ('u1', 'ann@example.com', ?), ('u2', 'bob@example.com', ?), ('u3', 'oauth@example.com', NULL), ('u4', 'off@example.com', ?)`).run(hash, hash, hash);
  db.exec(`INSERT INTO user_flags (user_id, disabled) VALUES ('u4', 1)`);
  return { db, env };
}
let ipN = 1;
const call = async (mod, env, body, { ip, headers = {} } = {}) => {
  const req = new Request('https://vaneapp.dev/api/auth/x', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip ?? `203.0.113.${(ipN++ % 200) + 1}`, 'user-agent': 'unit', ...headers }, body: JSON.stringify(body) });
  const res = await mod.onRequestPost({ request: req, env, params: {}, waitUntil() {} });
  let data = null; try { data = await res.clone().json(); } catch { /* */ }
  return { status: res.status, data, headers: res.headers };
};
const ask = (env, email, o) => call(forgot, env, { email }, o);
const set = (env, email, code, pw = 'new-password-1', o) => call(reset, env, { email, code, password: pw }, o);
const signIn = (env, email, pw) => call(login, env, { email, password: pw });
const backdate = (db, email, secs) => db.prepare('UPDATE password_resets SET created_at = created_at - ? WHERE email = ?').run(secs, email);

console.log('\nasking for a code');
{
  const { db, env } = await fresh(); mails.length = 0;
  const a = await ask(env, 'ann@example.com');
  const u = await ask(env, 'nobody@example.com');
  check('a known address gets 202 and ONE mail with a 6-digit code', a.status === 202 && mails.length === 1 && /^\d{6}$/.test(codeOf(mails[0])) && toOf(mails[0]).includes('ann@example.com'), JSON.stringify(mails));
  check('an unknown address gets the very same answer and no mail', u.status === 202 && JSON.stringify(u.data) === JSON.stringify(a.data) && mails.length === 1);
  check('the answer is { ok, expiresIn: 900, resendIn: 60 }', a.data.ok === true && a.data.expiresIn === 900 && a.data.resendIn === 60);
  const row = db.prepare('SELECT * FROM password_resets').get();
  check('only an HMAC of the code is stored, never the code', row && !JSON.stringify(row).includes(codeOf(mails[0])) && row.code_hash.length > 20);
  check('the stored hash is bound to the purpose: HMAC("reset", email, code), so it is useless as any other kind of code', await (async () => {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.JWT_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = async (purpose) => Buffer.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${purpose}\nann@example.com\n${codeOf(mails[0])}`)))).toString('base64url');
    return row.code_hash === await mac('reset') && row.code_hash !== await mac('login') && row.code_hash !== await mac('signup');
  })());
  check('the mail is transactional: no unsubscribe footer', !/Unsubscribe/i.test(mails[0].text) && !/Unsubscribe/i.test(mails[0].html));
  check('the mail says what to do if it was not you', /ignore this email/.test(mails[0].text));
}
{
  const { env } = await fresh({ email: false }); mails.length = 0;
  check('email not set up on the server: 404 (the page hides the link)', (await ask(env, 'ann@example.com')).status === 404 && (await set(env, 'ann@example.com', '123456')).status === 404 && mails.length === 0);
}
{
  const { env } = await fresh();
  for (const bad of ['', 'no-at-sign', 'a@b', 42, null, 'x'.repeat(260) + '@example.com']) check(`a bad address ${JSON.stringify(bad)?.slice(0, 20)} is a 400`, (await ask(env, bad)).status === 400);
}
{
  const { db, env } = await fresh(); mails.length = 0;
  await ask(env, 'ann@example.com');
  const again = await ask(env, 'ann@example.com');
  check('a second request within a minute sends nothing new (same 202)', again.status === 202 && mails.length === 1);
  backdate(db, 'ann@example.com', 61);
  const first = codeOf(mails[0]);
  await ask(env, 'ann@example.com');
  check('after the minute a new code is mailed', mails.length === 2 && codeOf(mails[1]) !== undefined);
  const old = await set(env, 'ann@example.com', first);
  check('the previous code stops working (unless it happens to be equal)', first === codeOf(mails[1]) || old.status === 400);
}
{
  const { env } = await fresh(); mails.length = 0;
  const hits = [];
  for (let i = 0; i < 7; i++) hits.push((await ask(env, 'ghost@example.com', { ip: `198.51.100.${i + 1}` })).status);
  const known = []; const { db: db2, env: env2 } = await fresh();
  for (let i = 0; i < 7; i++) { known.push((await ask(env2, 'ann@example.com', { ip: `198.51.100.${i + 1}` })).status); backdate(db2, 'ann@example.com', 61); }
  check('at most 5 requests an hour per address, and an address with no account is limited exactly the same', JSON.stringify(hits) === JSON.stringify([202, 202, 202, 202, 202, 429, 429]) && JSON.stringify(known) === JSON.stringify(hits), `${hits} / ${known}`);
}
{
  const { env } = await fresh(); mails.length = 0;
  const codes = []; for (let i = 0; i < 22; i++) codes.push((await ask(env, `user${i}@example.com`, { ip: '192.0.2.9' })).status);
  check('at most 20 requests an hour per network', codes.slice(0, 20).every((s) => s === 202) && codes[20] === 429, codes.join(','));
}
{
  const { env } = await fresh(); mails.length = 0;
  await ask(env, 'off@example.com'); await ask(env, 'oauth@example.com');
  check('a disabled account gets no mail', !mails.some((m) => toOf(m).includes('off@')));
  check('an account that signs in with Google/GitHub (no password yet) can set one', mails.some((m) => toOf(m).includes('oauth@')));
}
{
  const { env } = await fresh();
  const r = await ask(env, 'ann@example.com', { headers: { origin: 'https://evil.example' } });
  check('a request from another site is refused (CSRF)', r.status === 403);
  check('…and so is the reset itself', (await set(env, 'ann@example.com', '123456', 'new-password-1', { headers: { 'sec-fetch-site': 'cross-site' } })).status === 403);
}

console.log('\nsetting the new password');
{
  const { db, env } = await fresh(); mails.length = 0;
  const tA = await session.createSession(env, new Request('https://vaneapp.dev/'), 'u1'); await session.createSession(env, new Request('https://vaneapp.dev/'), 'u1');
  const tB = await session.createSession(env, new Request('https://vaneapp.dev/'), 'u2');
  for (let i = 0; i < 9; i++) await signIn(env, 'ann@example.com', 'wrong-password');   // lock Ann out by failed attempts
  const locked = await signIn(env, 'ann@example.com', 'old-password-1');
  await ask(env, 'ann@example.com');
  const code = codeOf(lastMail());
  const r = await set(env, 'ann@example.com', code);
  check('the right code sets the password (200)', r.status === 200 && r.data.ok === true, JSON.stringify(r));
  check('the person is NOT signed in by it (no cookie)', !r.headers.get('set-cookie'));
  check('the password is stored hashed and the new one verifies', await (async () => { const h = db.prepare(`SELECT password_hash h FROM users WHERE id = 'u1'`).get().h; return h !== 'new-password-1' && await password.verifyPassword('new-password-1', h) && !(await password.verifyPassword('old-password-1', h)); })());
  check("every session of that account is ended, other accounts keep theirs", db.prepare(`SELECT COUNT(*) n FROM sessions WHERE user_id = 'u1'`).get().n === 0 && db.prepare(`SELECT COUNT(*) n FROM sessions WHERE user_id = 'u2'`).get().n === 1);
  check('a "your password was changed" mail goes to the owner', toOf(mails.at(-1)).includes('ann@example.com') && /password was changed/i.test(mails.at(-1).subject));
  check("the other account's password is untouched", await password.verifyPassword('old-password-1', db.prepare(`SELECT password_hash h FROM users WHERE id = 'u2'`).get().h));
  const login1 = await signIn(env, 'ann@example.com', 'new-password-1');
  check('the new password signs in at once, even though the account was locked by failed attempts', locked.status === 429 && login1.status === 200, `${locked.status} -> ${login1.status}`);
  check('the old password no longer does', (await signIn(env, 'ann@example.com', 'old-password-1')).status === 401);
  check('the code is used up: the same request again fails', (await set(env, 'ann@example.com', code, 'another-password-1')).status >= 400);
  check('and the password stayed the one just set', await password.verifyPassword('new-password-1', db.prepare(`SELECT password_hash h FROM users WHERE id = 'u1'`).get().h));
}
{
  const { db, env } = await fresh(); mails.length = 0;
  await ask(env, 'ann@example.com'); const code = codeOf(lastMail());
  const wrong = code === '000000' ? '000001' : '000000';
  const results = [];
  for (let i = 0; i < 5; i++) results.push(await set(env, 'ann@example.com', wrong));
  check('a wrong code is a 400 that counts the tries left', results[0].status === 400 && /4 tries left/.test(results[0].data.error), results[0].data?.error);
  check('after 5 wrong guesses the code is dead…', results[4].status === 410);
  const right = await set(env, 'ann@example.com', code);
  check('…even the right one', right.status === 410, JSON.stringify(right));
  check('and the password was not changed', await password.verifyPassword('old-password-1', db.prepare(`SELECT password_hash h FROM users WHERE id = 'u1'`).get().h));
}
{
  const { db, env } = await fresh(); mails.length = 0;
  await ask(env, 'ann@example.com'); const code = codeOf(lastMail());
  const rs = await Promise.all([1, 2, 3, 4].map(() => set(env, 'ann@example.com', code)));
  check('four parallel requests with the right code: exactly one wins', rs.filter((r) => r.status === 200).length === 1, rs.map((r) => r.status).join(','));
}
{
  const { db, env } = await fresh(); mails.length = 0;
  await ask(env, 'ann@example.com'); const code = codeOf(lastMail());
  db.prepare('UPDATE password_resets SET expires_at = expires_at - 1000').run();
  check('an expired code is refused (410)', (await set(env, 'ann@example.com', code)).status === 410);
}
{
  const { db, env } = await fresh(); mails.length = 0;
  await ask(env, 'ann@example.com'); const code = codeOf(lastMail());
  check("Ann's code does not reset Bob's password", (await set(env, 'bob@example.com', code)).status === 410 && await password.verifyPassword('old-password-1', db.prepare(`SELECT password_hash h FROM users WHERE id = 'u2'`).get().h));
  check('a password that is too short is refused WITHOUT using the code up', (await set(env, 'ann@example.com', code, 'short')).status === 400 && (await set(env, 'ann@example.com', code)).status === 200);
}
{
  const { env } = await fresh(); mails.length = 0;
  await ask(env, 'ann@example.com');
  for (const c of ['12345', '1234567', 'abcdef', '', null, '12 34 5']) check(`a bad code ${JSON.stringify(c)} is a 400`, (await set(env, 'ann@example.com', c)).status === 400);
  check('a password of 129 characters is refused', (await set(env, 'ann@example.com', '123456', 'x'.repeat(129))).status === 400);
  check('a code typed with spaces ("123 456") is accepted as 123456', (await set(env, 'ann@example.com', codeOf(lastMail()).replace(/^(\d{3})(\d{3})$/, '$1 $2'))).status === 200);
}
{
  const { env } = await fresh(); mails.length = 0;
  const hits = []; for (let i = 0; i < 32; i++) hits.push((await set(env, 'ghost@example.com', '000000', 'new-password-1', { ip: '192.0.2.77' })).status);
  check('an address with no account: always the same "not valid" answer, never "no such account"', hits.slice(0, 30).every((s) => s === 410));
}
{
  // a brute-forcer: one network, many accounts, 5 wrong guesses on each code (the limit per code) until the network is stopped at 30
  const { db, env } = await fresh(); mails.length = 0;
  for (let i = 0; i < 7; i++) db.prepare(`INSERT INTO users (id, email, password_hash) VALUES (?, ?, 'x')`).run(`v${i}`, `victim${i}@example.com`);
  const statuses = [];
  for (let i = 0; i < 7; i++) {
    await ask(env, `victim${i}@example.com`, { ip: `198.18.0.${i + 1}` });
    const code = codeOf(lastMail()); const wrong = code === '000000' ? '000001' : '000000';
    for (let g = 0; g < 5; g++) statuses.push((await set(env, `victim${i}@example.com`, wrong, 'new-password-1', { ip: '192.0.2.88' })).status);
  }
  check('wrong codes from ONE network are counted across accounts: after 30 the network is stopped (429)', statuses.slice(0, 30).every((x) => x === 400 || x === 410) && statuses.slice(30).every((x) => x === 429), statuses.join(','));
  check('and another network is not affected', (await set(env, 'victim0@example.com', '123456', 'new-password-1', { ip: '203.0.113.200' })).status !== 429);
}

console.log('\nthe code cannot be used for anything else');
{
  const { db, env } = await fresh(); mails.length = 0;
  await ask(env, 'ann@example.com'); const code = codeOf(lastMail());
  const req = new Request('https://vaneapp.dev/api/auth/verify', { method: 'POST', headers: { 'cf-connecting-ip': '203.0.113.5' } });
  const asLogin = await emailcode.consumeCode(env, req, 'ann@example.com', 'login', code);
  const asSignup = await emailcode.consumeCode(env, req, 'ann@example.com', 'signup', code);
  check('it does not open a sign-in ("login" code)', asLogin.ok === false);
  check('it does not finish a sign-up ("signup" code)', asSignup.ok === false);
  check('and it was not used up by those tries', (await set(env, 'ann@example.com', code)).status === 200);
}
{
  const { db, env } = await fresh(); mails.length = 0;
  await ask(env, 'ann@example.com');
  const secret = env.JWT_SECRET;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = Buffer.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('login\nann@example.com\n424242')))).toString('base64url');
  db.prepare(`INSERT INTO email_verifications (email, purpose, code_hash, attempts, created_at, expires_at) VALUES ('ann@example.com', 'login', ?, 0, ?, ?)`).run(sig, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000) + 600);
  check('a pending SIGN-IN code does not reset a password', (await set(env, 'ann@example.com', '424242')).status >= 400 && await password.verifyPassword('old-password-1', db.prepare(`SELECT password_hash h FROM users WHERE id = 'u1'`).get().h));
}

console.log('\nthe table is missing (migration not run)');
{
  const { db, env } = await fresh(); mails.length = 0;
  db.exec('DROP TABLE password_resets');
  const a = await ask(env, 'ann@example.com'), b = await set(env, 'ann@example.com', '123456');
  check('both answer 503 "not available" instead of failing, and nothing is mailed', a.status === 503 && b.status === 503 && mails.length === 0);
}

console.log('\nthe pages');
{
  const html = readFileSync('public/reset.html', 'utf8'); const js = readFileSync('public/assets/reset.js', 'utf8'); const lg = readFileSync('public/login.html', 'utf8'); const au = readFileSync('public/assets/auth.js', 'utf8');
  check('/reset exists, is not indexed, and loads its script', /noindex/.test(html) && /assets\/reset\.js\?v=/.test(html));
  check('it posts to /api/auth/forgot and /api/auth/reset', /\/api\/auth\/forgot/.test(js) && /\/api\/auth\/reset/.test(js));
  check('it hides itself when email is not set up (404)', /404/.test(js));
  check('the login page links to it, only when email is on', /href="\/reset"/.test(lg) && /id="forgotLink"/.test(lg) && /email\.enabled|email && .*enabled/.test(au));
}

globalThis.fetch = realFetch;
console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
