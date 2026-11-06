#!/usr/bin/env node
/**
 * End-to-end test of the WEBHOOKS against LOCAL servers: subscribing over HTTP, then the real cron worker delivering an event to a
 * receiver this script runs, with signature check, failed first try and the retry.
 *
 *   npm run db:local
 *   npm run dev                                                  (terminal 1, http://localhost:8788)
 *   npm run cron:dev                                             (terminal 2, http://localhost:8787, optional: without it only the
 *                                                                 subscription part runs)
 *   npm run test:webhooks
 *
 * The worker needs worker/.dev.vars with the SAME ENCRYPTION_KEY as .dev.vars (cp .dev.vars worker/.dev.vars).
 * Nothing leaves your machine: the "late" post the worker fails is a placeholder row, and the receiver is on localhost
 * (the subscription is created with a public https address, as the API demands, and then pointed at localhost in the database).
 */
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createHmac, randomUUID } from 'node:crypto';

const BASE = process.env.BASE ?? 'http://localhost:8788';
const WORKER = process.env.WORKER ?? 'http://localhost:8787';
let passed = 0;
const failures = [];
const check = (name, cond, extra = '') => { if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failures.push(name); console.log(`  ✗ ${name} ${extra}`); } };
const section = (t) => console.log(`\n${t}`);

async function http(method, path, { cookie, key, body } = {}) {
  const res = await fetch(BASE + path, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), origin: BASE, ...(cookie ? { cookie } : {}), ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, data, res };
}
function sql(command) {
  const r = spawnSync('npx', ['wrangler', 'd1', 'execute', 'vane-db', '--local', '--json', '--command', command], { encoding: 'utf8', env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1', NO_COLOR: '1' } });
  if (r.status !== 0) throw new Error(`wrangler failed: ${r.stderr || r.stdout}`);
  try { return JSON.parse(r.stdout.slice(r.stdout.indexOf('[')))[0]?.results ?? []; } catch { return []; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try { await fetch(BASE + '/api/v1/openapi.json'); } catch { console.error(`Cannot reach ${BASE}. Start it with: npm run db:local && npm run dev`); process.exit(2); }
const workerUp = await fetch(WORKER + '/__scheduled?cron=*+*+*+*+*').then((r) => r.ok).catch(() => false);

// ── an account and a key
const email = `hook-${Date.now()}@example.com`, pw = 'hook-password-123';
const reg = await http('POST', '/api/auth/register', { body: { email, password: pw, name: 'Hook', timezone: 'UTC', birthDate: '1990-01-15' } });
if (!reg.data?.ok) { console.error('register failed', reg.status, reg.data); process.exit(2); }
const login = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email, password: pw }) });
const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
const userId = reg.data.user.id;
const mint = await http('POST', '/api/keys', { cookie, body: { name: 'webhooks e2e', mode: 'live' } });
const key = mint.data?.secret;
const test = await http('POST', '/api/keys', { cookie, body: { name: 'webhooks e2e test', mode: 'test' } });

section('subscribing over HTTP');
check('no key: 401', (await http('GET', '/api/v1/webhooks')).status === 401);
check('http:// is refused', (await http('POST', '/api/v1/webhooks', { key, body: { url: 'http://example.com/h' } })).data?.code === 'invalid_url');
check('localhost is refused', (await http('POST', '/api/v1/webhooks', { key, body: { url: 'https://localhost/h' } })).data?.code === 'invalid_url');
check('an IP address is refused', (await http('POST', '/api/v1/webhooks', { key, body: { url: 'https://203.0.113.5/h' } })).data?.code === 'invalid_url');
check('a bad event name is refused', (await http('POST', '/api/v1/webhooks', { key, body: { url: 'https://hooks.example.com/x', events: ['nope'] } })).data?.code === 'invalid_events');
const first = await http('POST', '/api/v1/webhooks', { key, body: { url: 'https://hooks.example.com/vane' } });
check('a good address is created (201) and shows the signing secret once', first.status === 201 && /^whsec_[0-9a-f]{48}$/.test(first.data.secret));
check('the same address twice is a 409', (await http('POST', '/api/v1/webhooks', { key, body: { url: 'https://hooks.example.com/vane' } })).data?.code === 'webhook_exists');
const list = await http('GET', '/api/v1/webhooks', { key });
check('the list shows it without the secret', list.data.webhooks.length === 1 && !JSON.stringify(list.data).includes('whsec_'));
check('a test key saves nothing', (await http('POST', '/api/v1/webhooks', { key: test.data.secret, body: { url: 'https://test.example.com/h' } })).data?.test === true && (await http('GET', '/api/v1/webhooks', { key })).data.webhooks.length === 1);
check('it can be deleted, once', (await http('DELETE', `/api/v1/webhooks/${first.data.webhook.id}`, { key })).status === 200 && (await http('DELETE', `/api/v1/webhooks/${first.data.webhook.id}`, { key })).status === 404);
const sub = await http('POST', '/api/v1/webhooks', { key, body: { url: 'https://hooks.example.com/delivery' } });

section('delivery by the real cron worker');
if (!workerUp) {
  console.log(`  - skipped: the worker is not running at ${WORKER} (npm run cron:dev, with worker/.dev.vars)`);
} else {
  // the receiver: answers 500 the first time and 200 after, and checks the signature with the secret it was given
  const got = [];
  let calls = 0;
  const server = createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c));
    req.on('end', () => {
      const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(req.headers['vane-signature'] ?? '');
      got.push({ event: req.headers['vane-event'], delivery: req.headers['vane-delivery'], ua: req.headers['user-agent'], valid: !!m && createHmac('sha256', sub.data.secret).update(`${m[1]}.${b}`).digest('hex') === m[2], body: JSON.parse(b) });
      calls++; res.writeHead(calls === 1 ? 500 : 200); res.end();
    });
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const ch = randomUUID(), postId = randomUUID(), now = Math.floor(Date.now() / 1000);
  sql(`INSERT INTO channels (id, user_id, type, name, credentials) VALUES ('${ch}', '${userId}', 'telegram', 'webhooks e2e', 'x')`);
  // a post that should have gone out two hours ago: the worker fails it, and that must reach the subscriber as "post.failed"
  sql(`INSERT INTO posts (id, group_id, user_id, channel_id, content, scheduled_at, status) VALUES ('${postId}', '${randomUUID()}', '${userId}', '${ch}', 'late post', ${now - 7200}, 'scheduled')`);
  sql(`UPDATE webhook_subscriptions SET url = 'http://localhost:${port}/hook' WHERE id = '${sub.data.webhook.id}'`);

  const runCron = () => fetch(WORKER + '/__scheduled?cron=*+*+*+*+*').then((r) => r.status);
  const delivery = () => sql(`SELECT id, status, attempts, last_error FROM webhook_deliveries WHERE subscription_id = '${sub.data.webhook.id}'`)[0];
  check('the cron run answers 200', (await runCron()) === 200);
  for (let i = 0; i < 20 && !got.length; i++) await sleep(500);
  check('the worker failed the late post', sql(`SELECT status FROM posts WHERE id = '${postId}'`)[0]?.status === 'failed');
  check('the receiver got ONE request, a POST of JSON', got.length === 1);
  const g = got[0] ?? { body: {}, valid: false };
  check('event "post.failed" with a Vane-Delivery id and the Vane user agent', g.event === 'post.failed' && !!g.delivery && g.ua === 'Vane-Webhooks/1', JSON.stringify(g));
  check('the signature is valid for the secret the API showed', g.valid === true);
  check('the body names the post and its failure', g.body.type === 'post.failed' && g.body.data?.post?.id === postId && g.body.data.post.status === 'failed', JSON.stringify(g.body).slice(0, 200));
  check('no channel credentials are in the body', !JSON.stringify(g.body).includes('"x"') || !/credentials/i.test(JSON.stringify(g.body)));
  await sleep(500);
  const d1 = delivery();
  check('the 500 left the delivery pending for a retry, with the reason', d1?.status === 'pending' && d1.attempts === 1 && /HTTP 500/.test(d1.last_error ?? ''), JSON.stringify(d1));

  sql(`UPDATE webhook_deliveries SET next_attempt_at = 0 WHERE subscription_id = '${sub.data.webhook.id}'`);
  await runCron();
  for (let i = 0; i < 20 && got.length < 2; i++) await sleep(500);
  await sleep(500);
  const d2 = delivery();
  check('the retry reached the receiver with the SAME Vane-Delivery id', got.length === 2 && got[1].delivery === got[0].delivery && got[1].valid === true);
  check('and the delivery is now marked delivered', d2?.status === 'delivered' && d2.attempts === 2, JSON.stringify(d2));
  check('the subscription shows the last status 200', sql(`SELECT last_status FROM webhook_subscriptions WHERE id = '${sub.data.webhook.id}'`)[0]?.last_status === 200);
  await runCron(); await sleep(800);
  check('a later run sends nothing more', got.length === 2);
  server.close();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
