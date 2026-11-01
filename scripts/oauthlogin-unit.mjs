#!/usr/bin/env node
/**
 * Unit checks for signing in with Google / GitHub (functions/api/lib/oauthlogin.ts + oauthflow.ts) on an in-memory SQLite copy of schema.sql,
 * no network:  npm run test:unit
 *
 * The bug these guard: pressing "Sign in with Google" with an address that has no account used to send the person back to the login
 * page with nothing useful on it. Now a sign-in (intent "login") never creates an account and answers "noaccount", and the login page
 * reads the reason before it rewrites its own address.
 */
import { build } from 'esbuild';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'vane-unit-'));
const load = async (entry, name) => {
  await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: join(dir, `${name}.mjs`), logLevel: 'silent' });
  return import(pathToFileURL(join(dir, `${name}.mjs`)).href);
};
const ol = await load('functions/api/lib/oauthlogin.ts', 'oauthlogin');
const of = await load('functions/api/lib/oauthflow.ts', 'oauthflow');
rmSync(dir, { recursive: true, force: true });

function fresh() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync('schema.sql', 'utf8'));
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
const req = () => new Request('https://vaneapp.dev/api/auth/oauth/google/callback', { headers: { 'user-agent': 'unit-test', 'cf-connecting-ip': '203.0.113.7' } });
const count = (db, table) => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);

let passed = 0;
const failed = [];
const check = (name, cond, extra = '') => { if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed.push(name); console.log(`  ✗ ${name} ${extra}`); } };

const NEW = { subject: 'g-123', email: 'new.person@example.com', name: 'New Person' };

console.log('\nSign in (intent "login") with an address that has no account');
{
  const { db, env } = fresh();
  const r = await ol.signInWith(env, req(), 'google', NEW, 'login');
  check('it answers "noaccount"', r.ok === false && r.code === 'noaccount', JSON.stringify(r));
  check('no account is created', count(db, 'users') === 0);
  check('nothing is linked to the provider', count(db, 'oauth_identities') === 0);
  check('no session is opened', count(db, 'sessions') === 0);
  const a = db.prepare('SELECT kind, ok, reason FROM auth_attempts').all();
  check('the attempt is logged as a failed sign-in with its reason', a.length === 1 && a[0].kind === 'login' && a[0].ok === 0 && a[0].reason === 'oauth_no_account', JSON.stringify(a));
}
{
  const { db, env } = fresh();
  const r = await ol.signInWith(env, req(), 'github', NEW, 'login');
  check('GitHub behaves the same', r.ok === false && r.code === 'noaccount' && count(db, 'users') === 0);
}

console.log('\nSign in (intent "login") when the account exists');
{
  const { db, env } = fresh();
  db.exec(`INSERT INTO users (id, email) VALUES ('u1', 'new.person@example.com')`);
  const r = await ol.signInWith(env, req(), 'google', NEW, 'login');
  check('an account found by its verified email signs in', r.ok === true && /vane_session|=/.test(r.cookie), JSON.stringify(r));
  check('the provider is linked to it for next time', db.prepare(`SELECT user_id FROM oauth_identities WHERE provider = 'google' AND subject = 'g-123'`).get()?.user_id === 'u1');
  check('no second account is made', count(db, 'users') === 1);
  const again = await ol.signInWith(env, req(), 'google', { ...NEW, email: 'changed@example.com' }, 'login');
  check('later it is found by the provider id even if the email changed', again.ok === true && count(db, 'users') === 1);
}
{
  const { db, env } = fresh();
  db.exec(`INSERT INTO users (id, email) VALUES ('u1', 'new.person@example.com')`);
  db.exec(`INSERT INTO user_flags (user_id, disabled) VALUES ('u1', 1)`);
  const r = await ol.signInWith(env, req(), 'google', NEW, 'login');
  check('a disabled account stays locked out', r.ok === false && r.code === 'disabled');
}

console.log('\nCreate account (intent "register")');
{
  const { db, env } = fresh();
  const r = await ol.signInWith(env, req(), 'google', NEW, 'register');
  check('a new address without the date of birth is asked for it ("age"), as before', r.ok === false && r.code === 'age', JSON.stringify(r));
  check('and still no account is created', count(db, 'users') === 0);
}
{
  const { db, env } = fresh();
  const r = await ol.signInWith(env, req(), 'google', NEW);
  check('with no intent given the old behaviour is kept ("age")', r.ok === false && r.code === 'age');
}

console.log('\nThe state that travels through the provider');
{
  const state = (obj) => new Request('https://vaneapp.dev/api/auth/oauth/google/callback', { headers: { cookie: `vane_oauth=${encodeURIComponent(JSON.stringify(obj))}` } });
  const base = { p: 'google', state: 's'.repeat(30), verifier: 'v'.repeat(40), product: 'post', next: '' };
  check('intent "login" survives the round trip', of.readState(state({ ...base, intent: 'login' }))?.intent === 'login');
  check('intent "register" survives the round trip', of.readState(state({ ...base, intent: 'register' }))?.intent === 'register');
  check('a cookie from before this change counts as "register" (the old flow still works)', of.readState(state(base))?.intent === 'register');
  check('a strange intent counts as "register", never as a way to skip checks', of.readState(state({ ...base, intent: 'admin' }))?.intent === 'register');
  const redirect = of.loginRedirect(new Request('https://vaneapp.dev/x'), 'noaccount', 'google');
  check('the redirect names the reason and the provider', redirect.headers.get('location') === 'https://vaneapp.dev/login?error=noaccount&via=google');
  check('a redirect without a provider is unchanged', of.loginRedirect(new Request('https://vaneapp.dev/x'), 'busy').headers.get('location') === 'https://vaneapp.dev/login?error=busy');
}

console.log('\nThe routes and the login page (source checks)');
{
  const start = readFileSync('functions/api/auth/oauth/[provider]/start.ts', 'utf8');
  const cb = readFileSync('functions/api/auth/oauth/[provider]/callback.ts', 'utf8');
  check('start.ts defaults to "login" and puts the intent into the state cookie', /intent'\) === 'register' \? 'register' : 'login'/.test(start) && /JSON\.stringify\(\{[^}]*\bintent\b/.test(start));
  check('callback.ts hands the intent to signInWith and names the provider in the redirect', /signInWith\(env, request, p, id, saved\.intent\)/.test(cb) && /loginRedirect\(request, r\.code, p\)/.test(cb));
  const js = readFileSync('public/assets/auth.js', 'utf8');
  const firstSetMode = js.search(/\n\s*setMode\(/);
  const params = js.indexOf('var PARAMS = new URLSearchParams(location.search)');
  check('the login page reads its address BEFORE the first setMode() rewrites it', params > 0 && firstSetMode > params, `PARAMS at ${params}, first setMode at ${firstSetMode}`);
  check('the error and the provider come from that saved copy, not from the rewritten address', /PARAMS\.get\('error'\)/.test(js) && /PARAMS\.get\('via'\)/.test(js) && !/URLSearchParams\(location\.search\)\.get\('error'\)/.test(js));
  check('the buttons tell the server which tab the person is on', /'intent=' \+ \(mode === 'register' \? 'register' : 'login'\)/.test(js));
  check('"noaccount" opens the Create account tab with a plain message', /oauthError === 'noaccount'/.test(js) && /There is no Vane account for that/.test(js) && /oauthError === 'age' \|\| oauthError === 'noaccount'/.test(js));
}

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
