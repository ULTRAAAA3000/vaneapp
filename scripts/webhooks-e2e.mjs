#!/usr/bin/env node
/**
 * End-to-end test of webhook DELIVERY: the real cron worker sends signed events to a local receiver.
 *
 *   npm run db:local && npm run dev     (terminal 1: the Pages app on :8788, with WEBHOOK_DEV_MODE=1 in .dev.vars)
 *   npm run test:webhooks               (terminal 2: starts the cron worker on :8787 itself if it is not running)
 *
 * Posts are never really sent anywhere: the channel is a placeholder with unreadable credentials, so a due post FAILS
 * (which is exactly the `post.failed` transition we want to observe) without touching Telegram.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const BASE = process.env.BASE ?? 'http://localhost:8788';
const CRON = process.env.CRON ?? 'http://localhost:8787';
let passed = 0;
const failures = [];
const check = (name, cond, extra = '') => { if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failures.push(name); console.log(`  ✗ ${name} ${extra}`); } };
const section = (t) => console.log(`\n${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, ms = 15000, step = 200) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(step); }
  return null;
}

async function http(method, path, { cookie, key, body } = {}) {
  const init = {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };
  let res;
  for (let attempt = 0; ; attempt++) {
    try { res = await fetch(BASE + path, init); break; }
    catch (err) { if (attempt >= 8) throw err; await sleep(750); }
  }
  let json = null; try { json = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, json, headers: res.headers };
}

const sql = (command) => {
  const r = spawnSync('npx', ['wrangler', 'd1', 'execute', 'vane-db', '--local', '--json', '--command', command], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`wrangler failed: ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout)[0].results;
};

function startReceiver() {
  const received = [];
  const mode = { status: 200, delayMs: 0, location: null };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8'), at: Date.now() });
      const answer = () => {
        try {
          if (mode.location) { res.writeHead(mode.status, { Location: mode.location }); return res.end(); }
          res.writeHead(mode.status); res.end('ok');
        } catch { /* the sender gave up (timeout): nothing to answer */ }
      };
      mode.delayMs ? setTimeout(answer, mode.delayMs) : answer();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    resolve({ url: `http://127.0.0.1:${port}/hook`, base: `http://127.0.0.1:${port}`, received, mode, close: () => server.closeAllConnections?.() ?? server.close() });
  }));
}

function verifyWebhook(secret, signatureHeader, rawBody) {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(signatureHeader ?? '');
  if (!m || Math.abs(Date.now() / 1000 - Number(m[1])) > 300) return false;
  return timingSafeEqual(createHmac('sha256', secret).update(`${m[1]}.${rawBody}`).digest(), Buffer.from(m[2], 'hex'));
}

// ───────────────────────── the cron worker ─────────────────────────
let workerProcess = null;
async function ensureWorker() {
  if (await fetch(CRON + '/').then(() => true).catch(() => false)) return;
  // The worker reads its secrets from worker/.dev.vars (git-ignored): borrow the app's ENCRYPTION_KEY, which must be the same.
  if (!existsSync('worker/.dev.vars')) {
    const key = readFileSync('.dev.vars', 'utf8').split('\n').find((l) => l.startsWith('ENCRYPTION_KEY='));
    if (!key) throw new Error('No ENCRYPTION_KEY in .dev.vars');
    writeFileSync('worker/.dev.vars', key + '\n');
  }
  workerProcess = spawn('npx', ['wrangler', 'dev', '--config', 'worker/wrangler.toml', '--test-scheduled', '--local', '--persist-to', '.wrangler/state', '--port', '8787'], { stdio: 'ignore', detached: true });
  const up = await until(() => fetch(CRON + '/').then(() => true).catch(() => false), 60000, 500);
  if (!up) throw new Error('The cron worker did not start on :8787');
}
async function tick() {
  // wrangler 4 serves /cdn-cgi/handler/scheduled, wrangler 3 serves /__scheduled. The reply comes before the work is done:
  // callers wait for the RESULT (a receiver hit, a database row), never for the reply.
  for (const path of ['/cdn-cgi/handler/scheduled', '/__scheduled']) {
    const r = await fetch(CRON + path).catch(() => null);
    if (r && r.status === 200) return;
  }
  throw new Error('could not trigger the scheduled event');
}

const inHours = (h) => new Date(Date.now() + h * 3600_000).toISOString().replace(/\.\d+Z$/, 'Z');

try {
  if (!(await fetch(BASE + '/api/auth/config').catch(() => null))) { console.error(`Cannot reach ${BASE}. Start it with: npm run db:local && npm run dev`); process.exit(2); }
  await ensureWorker();
  sql('DELETE FROM rate_limits');

  // ── a user on the Developer API plan, a placeholder channel, a webhook
  const email = `whe2e-${Date.now()}@example.com`, pw = 'Correct-Horse-9';
  await http('POST', '/api/auth/register', { body: { email, password: pw, name: 'WH', timezone: 'UTC' } });
  const login = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: pw }) });
  const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const uid = sql(`SELECT id FROM users WHERE email = '${email}'`)[0].id;
  spawnSync('node', ['scripts/set-plan.mjs', email, 'api', '--days', '30'], { encoding: 'utf8' });
  const key = (await http('POST', '/api/keys', { cookie, body: { name: 'wh e2e' } })).json.secret;
  const chan = randomUUID();
  sql(`INSERT INTO channels (id, user_id, type, name, credentials) VALUES ('${chan}', '${uid}', 'telegram', 'wh channel', 'x')`);
  const rx = await startReceiver();
  const created = await http('POST', '/api/v1/webhooks', { key, body: { url: rx.url } });
  if (created.status !== 201) { console.error('Could not create the webhook. Is WEBHOOK_DEV_MODE=1 set in .dev.vars?', JSON.stringify(created.json)); process.exit(2); }
  const hook = created.json.webhook, secret = created.json.secret;

  const post = async () => (await http('POST', '/api/v1/posts', { key, body: { content: `wh test ${randomUUID().slice(0, 8)}`, channelIds: [chan], scheduledAt: inHours(5) } })).json.posts[0].id;
  const cancel = async () => { const id = await post(); await http('DELETE', `/api/v1/posts/${id}`, { key }); return id; };
  const delivery = (postId) => sql(`SELECT id, event, status, attempts, last_error, next_attempt_at AS next, delivered_at FROM webhook_deliveries WHERE webhook_id = '${hook.id}' AND post_id = '${postId}'`)[0];
  const hookRow = () => sql(`SELECT active, failures, last_status AS s, last_delivery_at AS at, disabled_reason AS reason FROM webhooks WHERE id = '${hook.id}'`)[0];
  const reset = () => { rx.received.length = 0; rx.mode.status = 200; rx.mode.delayMs = 0; rx.mode.location = null; sql(`DELETE FROM webhook_deliveries WHERE webhook_id = '${hook.id}'`); sql(`UPDATE webhooks SET active = 1, failures = 0, disabled_reason = NULL WHERE id = '${hook.id}'`); };
  const nowSql = () => sql('SELECT unixepoch() AS n')[0].n;

  // ───────────────────────────────────────────────────────────────
  section('post.cancelled: queued with the cancel, delivered by the worker');
  {
    reset();
    const pid = await cancel();
    check('the event is queued, not yet sent', delivery(pid)?.status === 'pending' && rx.received.length === 0);
    await tick();
    const hit = await until(() => rx.received.find((r) => JSON.parse(r.body).data?.post?.id === pid));
    check('the receiver gets it', !!hit);
    const evt = hit ? JSON.parse(hit.body) : {};
    check('it is signed and the signature verifies with the secret from creation', verifyWebhook(secret, hit?.headers['vane-signature'], hit?.body ?? ''));
    check('headers: Vane-Event, Vane-Delivery (= the body id), User-Agent', hit?.headers['vane-event'] === 'post.cancelled' && hit.headers['vane-delivery'] === evt.id && hit.headers['user-agent'] === 'Vane-Webhooks/1.0');
    const d = await until(() => delivery(pid)?.status === 'done' && delivery(pid));
    check('the event id is evt_ + the outbox row id', evt.id === `evt_${d?.id}`);
    check('payload: type, createdAt and the post (id, groupId, channelId, status, content, platform)',
      evt.type === 'post.cancelled' && typeof evt.createdAt === 'number' && evt.data.post.status === 'cancelled' && evt.data.post.channelId === chan && evt.data.post.platform === 'telegram' && !!evt.data.post.groupId && /^wh test/.test(evt.data.post.content));
    check('the payload never contains credentials or secrets', !/credentials|secret|whsec_|cpost_/.test(hit?.body ?? ''));
    check('the delivery is marked done on the first attempt', d?.attempts === 1 && d?.delivered_at > 0);
    const h = hookRow();
    check('the webhook records the success (200, failures 0)', h.s === 200 && h.failures === 0 && h.at > 0);
    await tick(); await sleep(1500);
    check('a second tick does not send it again', rx.received.filter((r) => JSON.parse(r.body).data?.post?.id === pid).length === 1);
  }

  // ───────────────────────────────────────────────────────────────
  section('post.failed: the worker fails a post and the event follows in the same run');
  {
    reset();
    // (a) missed its time by over 2 hours
    const late = await post();
    sql(`UPDATE posts SET scheduled_at = unixepoch() - 3 * 3600 WHERE id = '${late}'`);
    // (b) due now, on its LAST attempt (the 5th), and the channel's credentials are unreadable: that failure is final.
    // (Earlier attempts would just be retried with backoff; this drives the worker's real `finish()` 'failed' branch.)
    const broken = await post();
    sql(`UPDATE posts SET scheduled_at = unixepoch() - 60, attempts = 4, updated_at = unixepoch() - 1000 WHERE id = '${broken}'`);
    await tick();
    const a = await until(() => rx.received.find((r) => JSON.parse(r.body).data?.post?.id === late));
    const b = await until(() => rx.received.find((r) => JSON.parse(r.body).data?.post?.id === broken));
    check('an overdue post → post.failed with the reason', !!a && JSON.parse(a.body).type === 'post.failed' && /more than 2 hours/.test(JSON.parse(a.body).data.post.error) && JSON.parse(a.body).data.post.status === 'failed');
    check('a post that fails on delivery → post.failed (the batch guarded by changes())', !!b && JSON.parse(b.body).type === 'post.failed' && JSON.parse(b.body).data.post.status === 'failed' && !!JSON.parse(b.body).data.post.error);
    check('both are signed correctly', verifyWebhook(secret, a?.headers['vane-signature'], a?.body ?? '') && verifyWebhook(secret, b?.headers['vane-signature'], b?.body ?? ''));
    await tick(); await sleep(1500);
    check('each failure produced exactly ONE event', [late, broken].every((id) => rx.received.filter((r) => JSON.parse(r.body).data?.post?.id === id).length === 1));
  }

  // ───────────────────────────────────────────────────────────────
  section('Retries with backoff');
  {
    reset(); rx.mode.status = 500;
    const pid = await cancel();
    const t0 = nowSql();
    await tick();
    const first = await until(() => delivery(pid)?.status === 'pending' && delivery(pid)?.attempts === 1 && delivery(pid));
    check('a 500 → the delivery goes back to pending after attempt 1', !!first && rx.received.length === 1);
    check('…due again in about a minute (1 min backoff)', first && first.next >= t0 + 55 && first.next <= t0 + 75, `next=${first?.next - t0}s`);
    check('…with the reason recorded', /500/.test(first?.last_error ?? ''));
    const h1 = hookRow();
    check('the webhook shows the last status (500) but is not counted as failing yet', h1.s === 500 && h1.failures === 0 && h1.active === 1);
    await tick(); await sleep(1500);
    check('it is NOT retried before it is due', rx.received.length === 1);
    rx.mode.status = 200;
    sql(`UPDATE webhook_deliveries SET next_attempt_at = unixepoch() - 1 WHERE id = '${first.id}'`);
    await tick();
    const done = await until(() => delivery(pid)?.status === 'done' && delivery(pid));
    check('when due and the endpoint is back: delivered on attempt 2', !!done && done.attempts === 2 && rx.received.length === 2);
    check('the retry carries the SAME event id (receivers dedupe on it)', JSON.parse(rx.received[0].body).id === JSON.parse(rx.received[1].body).id);
    check('the success resets the status (200)', hookRow().s === 200);
  }

  // ───────────────────────────────────────────────────────────────
  section('Giving up, and switching a broken webhook off');
  {
    reset(); rx.mode.status = 500;
    const pid = await cancel();
    const row = delivery(pid);
    sql(`UPDATE webhook_deliveries SET attempts = 5, next_attempt_at = unixepoch() - 1 WHERE id = '${row.id}'`);
    await tick();
    const dead = await until(() => delivery(pid)?.status === 'failed' && delivery(pid));
    check('the 6th failed attempt is final: the delivery is failed', !!dead && dead.attempts === 6 && /gave up after 6 attempts/.test(dead.last_error));
    check('…and counts one failure against the webhook', hookRow().failures === 1 && hookRow().active === 1);

    sql(`UPDATE webhooks SET failures = 9 WHERE id = '${hook.id}'`);
    const pid2 = await cancel();
    sql(`UPDATE webhook_deliveries SET attempts = 5, next_attempt_at = unixepoch() - 1 WHERE post_id = '${pid2}'`);
    await tick();
    const off = await until(() => hookRow().active === 0 && hookRow());
    check('the 10th consecutive failure switches the webhook OFF, with a reason', !!off && off.failures === 10 && /Too many failed deliveries/.test(off.reason));
    const pid3 = await cancel();
    check('a switched-off webhook gets no new events', delivery(pid3) === undefined);

    // a success after a failure resets the counter
    reset();
    sql(`UPDATE webhooks SET failures = 4 WHERE id = '${hook.id}'`);
    const pid4 = await cancel(); await tick();
    check('a delivered event resets the failure counter', !!(await until(() => hookRow().failures === 0)) && delivery(pid4)?.status === 'done');
  }

  // ───────────────────────────────────────────────────────────────
  section('Awkward endpoints');
  {
    reset(); rx.mode.status = 410;
    const gone = await cancel(); await tick();
    const g = await until(() => hookRow().active === 0 && hookRow());
    check('410 Gone switches the webhook off at once (and the delivery is failed, not retried)', !!g && /410 Gone/.test(g.reason) && delivery(gone)?.status === 'failed' && rx.received.length === 1);

    reset(); rx.mode.status = 302; rx.mode.location = rx.base + '/elsewhere';
    const redir = await cancel(); await tick();
    const r = await until(() => delivery(redir)?.status === 'pending' && delivery(redir)?.attempts === 1 && delivery(redir));
    await sleep(500);
    check('a redirect is NOT followed: retried later, the target is never called', !!r && /redirect/i.test(r.last_error) && !rx.received.some((x) => x.url === '/elsewhere'));

    reset(); rx.mode.delayMs = 12000;
    const slow = await cancel(); await tick();
    const s = await until(() => delivery(slow)?.status === 'pending' && delivery(slow)?.attempts === 1 && delivery(slow), 20000);
    check('an endpoint that never answers is cut off after 8 seconds and retried', !!s && /8 seconds/.test(s.last_error));
    rx.mode.delayMs = 0;
  }

  // ───────────────────────────────────────────────────────────────
  section('Robustness');
  {
    reset();
    // a delivery abandoned mid-send by a worker that died
    const pid = await cancel();
    const row = delivery(pid);
    sql(`UPDATE webhook_deliveries SET status = 'sending', attempts = 1, next_attempt_at = unixepoch() - 400 WHERE id = '${row.id}'`);
    await tick();
    check("a delivery stuck 'sending' for over 5 minutes is picked up again and delivered", !!(await until(() => delivery(pid)?.status === 'done')));

    // an event whose webhook was switched off while it waited
    reset();
    const pid2 = await cancel();
    sql(`UPDATE webhooks SET active = 0 WHERE id = '${hook.id}'`);
    await tick();
    const off = await until(() => delivery(pid2)?.status === 'failed' && delivery(pid2));
    check("an event queued before the webhook was switched off is not sent (failed: 'switched off')", !!off && /switched off/.test(off.last_error) && rx.received.length === 0);

    // an unreadable signing secret
    reset();
    const good = sql(`SELECT secret FROM webhooks WHERE id = '${hook.id}'`)[0].secret;
    const pid3 = await cancel();
    sql(`UPDATE webhooks SET secret = 'garbage' WHERE id = '${hook.id}'`);
    await tick();
    const bad = await until(() => delivery(pid3)?.status === 'failed' && delivery(pid3));
    check('an unreadable signing secret fails the delivery without crashing the run', !!bad && /signing secret/.test(bad.last_error) && rx.received.length === 0);
    sql(`UPDATE webhooks SET secret = '${good}' WHERE id = '${hook.id}'`);

    // a burst: 12 events, 10 per run, oldest first
    reset();
    const ids = [];
    for (let i = 0; i < 12; i++) ids.push(await cancel());
    await tick();
    await until(() => rx.received.length >= 10);
    await sleep(1200);
    check('a run sends at most 10 deliveries', rx.received.length === 10, `got ${rx.received.length}`);
    await tick();
    check('the next run sends the rest', !!(await until(() => rx.received.length === 12)));
    const order = rx.received.map((r) => JSON.parse(r.body).data.post.id);
    check('every event arrived exactly once', new Set(order).size === 12 && ids.every((id) => order.includes(id)));
    // Rows are claimed oldest first, but created_at has a resolution of one second, so within a second the order is not
    // defined. What IS guaranteed (and what we check): nothing sent in the first run is newer than what had to wait.
    const stamps = sql(`SELECT post_id, created_at AS at FROM webhook_deliveries WHERE webhook_id = '${hook.id}'`);
    const at = Object.fromEntries(stamps.map((r) => [r.post_id, r.at]));
    const firstRun = order.slice(0, 10).map((id) => at[id]), waited = order.slice(10).map((id) => at[id]);
    check('oldest first (to the second): nothing sent in the first run is newer than what waited', Math.max(...firstRun) <= Math.min(...waited), `${firstRun.join()} | ${waited.join()}`);
  }

  // ───────────────────────────────────────────────────────────────
  section('Deleting a webhook');
  {
    reset();
    const pid = await cancel();
    check('a pending event exists', delivery(pid)?.status === 'pending');
    check('deleting the webhook works', (await http('DELETE', `/api/v1/webhooks/${hook.id}`, { key })).status === 200);
    await tick(); await sleep(1500);
    check('nothing is delivered for a deleted webhook', rx.received.length === 0 && sql(`SELECT COUNT(*) AS n FROM webhook_deliveries WHERE post_id = '${pid}'`)[0].n === 0);
  }
  rx.close();
} catch (err) {
  console.error('\nTest run aborted:', err instanceof Error ? err.stack : err);
  if (workerProcess) try { process.kill(-workerProcess.pid); } catch { /* already gone */ }
  process.exit(2);
}

if (workerProcess) try { process.kill(-workerProcess.pid); } catch { /* already gone */ }
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('Failed:\n  - ' + failures.join('\n  - ')); process.exit(1); }
process.exit(0);
