const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const seen = [];
let answer = () => ({ status: 200, body: {} });
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, idem: req.headers['idempotency-key'], body: raw ? JSON.parse(raw) : null });
    const { status, body } = answer(req);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
});

let tester;
let appDef;
test.before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.VANE_API_BASE = `http://127.0.0.1:${server.address().port}/api/v1`;
  const zapier = require('zapier-platform-core');
  zapier.tools.env.inject();
  appDef = require('../index');
  tester = zapier.createAppTester(appDef);
});
test.after(() => server.close());

const auth = { api_key: 'cpost_test_' + 'A'.repeat(24) };
const bundle = (inputData = {}) => ({ authData: auth, inputData });

test('auth test calls /me with the bearer key', async () => {
  answer = () => ({ status: 200, body: { ok: true, key: { name: 'Zap', scope: 'post', mode: 'test' }, plan: 'free', apiAccess: true } });
  const r = await tester(appDef.authentication.test, bundle());
  assert.equal((r.data || r).plan, 'free');
  assert.equal(seen.at(-1).url, '/api/v1/me');
  assert.equal(seen.at(-1).auth, `Bearer ${auth.api_key}`);
});

test('bad key asks to reconnect', async () => {
  answer = () => ({ status: 401, body: { ok: false, code: 'invalid_api_key', error: 'Invalid API key.' } });
  await assert.rejects(tester(appDef.authentication.test, bundle()), /rejected the API key/);
});

test('channels dropdown: active channels only, labelled with the network', async () => {
  answer = () => ({ status: 200, body: { ok: true, channels: [{ id: 'a', platform: 'telegram', name: 'T', isActive: true }, { id: 'b', platform: 'x', name: 'X', isActive: false }] } });
  const r = await tester(appDef.triggers.channels.operation.perform, bundle());
  assert.deepEqual(r, [{ id: 'a', name: 'T (telegram)' }]);
});

test('published trigger keeps only sent posts, reads the history view', async () => {
  answer = () => ({ status: 200, body: { ok: true, posts: [{ id: '1', status: 'sent' }, { id: '2', status: 'failed' }, { id: '3', status: 'cancelled' }] } });
  const r = await tester(appDef.triggers.new_published_post.operation.perform, bundle());
  assert.deepEqual(r.map((p) => p.id), ['1']);
  assert.equal(seen.at(-1).url, '/api/v1/posts?view=history');
});

test('failed trigger keeps only failed posts', async () => {
  const r = await tester(appDef.triggers.post_failed.operation.perform, bundle());
  assert.deepEqual(r.map((p) => p.id), ['2']);
});

test('create post: body, one channel as a string, UTC time without zone, idempotency key', async () => {
  answer = () => ({ status: 201, body: { ok: true, groupId: 'g1', scheduledAt: 1790000000, posts: [{ id: 'p', channelId: 'a', status: 'scheduled' }] } });
  const r = await tester(appDef.creates.create_post.operation.perform, bundle({ content: 'Hi', channelIds: 'a', scheduledAt: '2026-10-20T09:00:00', mediaUrl: 'https://x.y/i.jpg' }));
  const s = seen.at(-1);
  assert.equal(s.method, 'POST');
  assert.deepEqual(s.body, { content: 'Hi', channelIds: ['a'], scheduledAt: '2026-10-20T09:00:00.000Z', mediaUrl: 'https://x.y/i.jpg' });
  assert.match(s.idem, /^zap-[0-9a-f]{40}$/);
  assert.equal(r.groupId, 'g1');
  assert.equal(r.channels, 1);
});

test('create post: same input gives the same idempotency key; no time means no key and a time about a minute ahead', async () => {
  const input = { content: 'Hi', channelIds: ['a'], scheduledAt: '2026-10-20T09:00:00Z' };
  await tester(appDef.creates.create_post.operation.perform, bundle(input));
  const k1 = seen.at(-1).idem;
  await tester(appDef.creates.create_post.operation.perform, bundle(input));
  assert.equal(seen.at(-1).idem, k1);
  await tester(appDef.creates.create_post.operation.perform, bundle({ content: 'Hi', channelIds: ['a'] }));
  const s = seen.at(-1);
  assert.equal(s.idem, undefined);
  const ahead = new Date(s.body.scheduledAt).getTime() - Date.now();
  assert.ok(ahead > 30_000 && ahead < 90_000, String(ahead));
});

test('API errors keep Vane\'s message and code', async () => {
  answer = () => ({ status: 402, body: { ok: false, code: 'quota_exceeded', error: 'You have used all posts.' } });
  await assert.rejects(tester(appDef.creates.create_post.operation.perform, bundle({ content: 'Hi', channelIds: ['a'] })), /\[402\] You have used all posts\. \(quota_exceeded\)/);
});

test('the action points its Channels field at the hidden trigger', () => {
  const f = appDef.creates.create_post.operation.inputFields.find((x) => x.key === 'channelIds');
  assert.equal(f.dynamic, 'channels.id.name');
  assert.ok(appDef.triggers.channels.display.hidden);
});
