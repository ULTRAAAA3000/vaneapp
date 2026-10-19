#!/usr/bin/env node
/**
 * Test of the host routing (functions/_middleware.ts) against a LOCAL dev server: post. and studio. each get their own
 * dashboard and their own slice of the API, the main site forwards, and one sign-in cookie covers both products.
 *
 *   npm run db:local && npm run dev        (in one terminal)
 *   npm run test:hosts                     (in another;  PORT=8788 by default)
 *
 * The Host header is set by hand, so no DNS or hosts-file changes are needed (that is why this uses node:http: fetch() forbids it).
 */
import http from 'node:http';

const PORT = Number(process.env.PORT ?? 8788);
let passed = 0;
const failures = [];
const check = (name, cond, extra = '') => { if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failures.push(name); console.log(`  ✗ ${name} ${extra}`); } };
const section = (t) => console.log(`\n${t}`);

function req(host, method, path, { body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request(
      { host: '127.0.0.1', port: PORT, method, path, headers: { host, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...(cookie ? { cookie } : {}) } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const POST = 'post.vaneapp.dev';
const STUDIO = 'studio.vaneapp.dev';
const APEX = 'vaneapp.dev';
const title = (res) => /<title>([^<]*)<\/title>/.exec(res.text)?.[1] ?? '';

try {
  section('post.vaneapp.dev: the posting dashboard');
  const pr = await req(POST, 'GET', '/');
  check('/ is the posting dashboard', pr.status === 200 && title(pr) === 'Dashboard — Vane', `${pr.status} ${title(pr)}`);
  const pa = await req(POST, 'GET', '/app');
  check('/app forwards to / (308)', pa.status === 308 && new URL(pa.headers.location).pathname === '/', `${pa.status} ${pa.headers.location}`);
  const pq = await req(POST, 'GET', '/app?connect=mastodon&status=ok');
  check('/app keeps the query when it forwards (the Mastodon return trip)', pq.status === 308 && new URL(pq.headers.location).search === '?connect=mastodon&status=ok', `${pq.status} ${pq.headers.location}`);
  const ps = await req(POST, 'GET', '/studio');
  check('/studio forwards to studio.vaneapp.dev', ps.status === 308 && pa.headers.location !== undefined && ps.headers.location === `https://${STUDIO}/`, ps.headers.location);
  check('the video API is not served here (404)', (await req(POST, 'GET', '/api/video/me')).status === 404 && (await req(POST, 'GET', '/api/v1/video/me')).status === 404);
  check('the posting API is (401 without a session)', (await req(POST, 'GET', '/api/channels')).status === 401);
  check('/login works here', (await req(POST, 'GET', '/login')).status === 200);

  section('studio.vaneapp.dev: Vane Studio');
  const sr = await req(STUDIO, 'GET', '/');
  check('/ is the video dashboard', sr.status === 200 && title(sr) === 'Studio — Vane', `${sr.status} ${title(sr)}`);
  const ss = await req(STUDIO, 'GET', '/studio');
  check('/studio forwards to / (308)', ss.status === 308 && new URL(ss.headers.location).pathname === '/');
  const sa = await req(STUDIO, 'GET', '/app');
  check('/app forwards to post.vaneapp.dev', sa.status === 308 && sa.headers.location === `https://${POST}/`, sa.headers.location);
  check('the video API is served (401 without a session)', (await req(STUDIO, 'GET', '/api/video/me')).status === 401 && (await req(STUDIO, 'GET', '/api/v1/video/me')).status === 401);
  check('the announce routes are served here, and only here (401 on studio., 404 on post.)', (await req(STUDIO, 'GET', '/api/video/announce')).status === 401 && (await req(POST, 'GET', '/api/video/announce')).status === 404 && (await req(STUDIO, 'POST', '/api/video/videos/x/announce')).status !== 404);
  check('the video channels routes are served on studio. only (401 / 404)', (await req(STUDIO, 'GET', '/api/video/channels')).status === 401 && (await req(POST, 'GET', '/api/video/channels')).status === 404);
  check('sign-in and keys are served', (await req(STUDIO, 'GET', '/api/auth/config')).status === 200 && (await req(STUDIO, 'GET', '/api/keys?scope=video')).status === 401);
  for (const p of ['/api/posts', '/api/channels', '/api/usage', '/api/v1/posts', '/api/v1/me', '/api/media/upload']) {
    const r = await req(STUDIO, p === '/api/media/upload' ? 'POST' : 'GET', p);
    check(`the posting API ${p} is not served here (404)`, r.status === 404, `${r.status}`);
  }
  check('/login works here', (await req(STUDIO, 'GET', '/login')).status === 200);

  section('vaneapp.dev: the main site');
  const ar = await req(APEX, 'GET', '/');
  check('/ is still the landing page', ar.status === 200 && title(ar) !== 'Dashboard — Vane' && title(ar) !== 'Studio — Vane', title(ar));
  check('/app forwards to post.vaneapp.dev', (await req(APEX, 'GET', '/app')).headers.location === `https://${POST}/`);
  check('/studio forwards to studio.vaneapp.dev', (await req(APEX, 'GET', '/studio')).headers.location === `https://${STUDIO}/`);
  check('www. behaves the same', (await req('www.vaneapp.dev', 'GET', '/app')).headers.location === `https://${POST}/`);
  check('the whole API still answers here, so existing integrations keep working', (await req(APEX, 'GET', '/api/v1/me')).status === 401 && (await req(APEX, 'GET', '/api/v1/video/me')).status === 401);

  section('Local dev and previews are left alone');
  const lr = await req('localhost:8788', 'GET', '/app');
  check('/app is served directly on localhost', lr.status === 200 && title(lr) === 'Dashboard — Vane', `${lr.status}`);
  check('/studio is served directly on localhost', (await req('localhost:8788', 'GET', '/studio')).status === 200);
  check('an unknown host is not rewritten', (await req('example.pages.dev', 'GET', '/app')).status === 200);

  section('One sign-in covers both products');
  const email = `hosts-e2e-${Date.now()}@example.com`;
  const reg = await req(STUDIO, 'POST', '/api/auth/register', { body: { email, password: 'Correct-Horse-9', name: 'E2E', timezone: 'UTC' } });
  check('sign-up works on studio.', reg.status === 200 || reg.status === 201, `${reg.status} ${reg.text.slice(0, 120)}`);
  const login = await req(STUDIO, 'POST', '/api/auth/login', { body: { email, password: 'Correct-Horse-9' } });
  const setCookie = [].concat(login.headers['set-cookie'] ?? []).join('\n');
  check('the session cookie is for the whole vaneapp.dev domain', /vane_session=[^;]+;[^]*Domain=vaneapp\.dev/i.test(setCookie), setCookie);
  check('and stays HttpOnly and SameSite=Lax', /HttpOnly/i.test(setCookie) && /SameSite=Lax/i.test(setCookie));
  const cookie = setCookie.split(';')[0];
  check('that cookie opens the video dashboard API on studio.', (await req(STUDIO, 'GET', '/api/video/me', { cookie })).status === 200);
  check('and the posting dashboard API on post.', (await req(POST, 'GET', '/api/usage', { cookie })).status === 200);
  const localLogin = await req('localhost:8788', 'POST', '/api/auth/login', { body: { email, password: 'Correct-Horse-9' } });
  check('on localhost the cookie stays host-only (no Domain)', !/Domain=/i.test([].concat(localLogin.headers['set-cookie'] ?? []).join('\n')));
} catch (err) {
  console.error('\nTest run aborted:', err instanceof Error ? err.message : err);
  process.exit(2);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('Failed:\n  - ' + failures.join('\n  - ')); process.exit(1); }
