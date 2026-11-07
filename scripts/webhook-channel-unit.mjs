#!/usr/bin/env node
/**
 * Unit checks for the Webhook channel (a post is sent as signed JSON to the person's own https address).
 * No server needed:  npm run test:unit
 */
import { build } from 'esbuild';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'vane-unit-'));
const bundle = async (entry, name) => {
  const out = join(dir, name);
  await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent' });
  return import(pathToFileURL(out).href);
};
const wh = await bundle('functions/api/channels/webhook.ts', 'webhook.mjs');
const crypto = await bundle('functions/api/lib/crypto.ts', 'crypto.mjs');
rmSync(dir, { recursive: true, force: true });

let passed = 0;
const failed = [];
const check = (name, cond, extra = '') => { if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed.push(name); console.log(`  ✗ ${name} ${extra}`); } };

const calls = [];
let answer = () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return answer(String(url), init); };
const reply = (status, body, headers = {}) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const URL_OK = 'https://hooks.example.com/vane';
const SECRET = 'whsec_' + 'ab'.repeat(24);
const creds = { url: URL_OK, secret: SECRET };
const post = { id: '11111111-2222-3333-4444-555555555555', content: 'Hello world', scheduledAt: 1_800_000_000, channelId: 'c1', channelName: 'My server' };

console.log('\nwebhook channel: connecting');
for (const bad of ['http://example.com/hook', 'https://localhost/hook', 'https://127.0.0.1/hook', 'https://10.0.0.5/hook', 'https://example.com:8443/hook', 'https://vaneapp.dev/api/health', 'ftp://example.com', '', 5, null]) {
  calls.length = 0;
  const r = await wh.validateWebhookEndpoint(bad, 'x');
  check(`refused without any call: ${JSON.stringify(bad)}`, !r.ok && r.code === 'bad_url' && calls.length === 0);
}
calls.length = 0;
answer = () => reply(200, {});
const okCheck = await wh.validateWebhookEndpoint(`  ${URL_OK}  `, 'My server');
check('a good address is accepted and trimmed', okCheck.ok && okCheck.url === URL_OK);
check('a signing secret is made', okCheck.ok && /^whsec_[0-9a-f]{48}$/.test(okCheck.secret));
check('exactly one test call is sent', calls.length === 1 && calls[0].init.method === 'POST');
check('the test call says what it is', calls[0].init.headers['Vane-Event'] === 'channel.test' && JSON.parse(calls[0].init.body).type === 'channel.test');
check('no redirect is followed', calls[0].init.redirect === 'manual');
{
  const h = calls[0].init.headers, m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(h['Vane-Signature']);
  const expect = m && createHmac('sha256', okCheck.secret).update(`${m[1]}.${calls[0].init.body}`).digest('hex');
  check('the test call is signed with the new secret over the raw body', !!m && m[2] === expect);
}
answer = () => reply(500, null);
check('a server answering 5xx is refused with its status', await (async () => { const r = await wh.validateWebhookEndpoint(URL_OK, 'x'); return !r.ok && r.code === 'refused' && /500/.test(r.error); })());
answer = () => reply(404, null);
check('a server answering 404 is refused', (await wh.validateWebhookEndpoint(URL_OK, 'x')).ok === false);
answer = () => reply(301, null, { location: 'https://other.example.com/' });
check('a redirect is explained, not followed', await (async () => { const r = await wh.validateWebhookEndpoint(URL_OK, 'x'); return !r.ok && /redirect/i.test(r.error); })());
answer = () => { throw new Error('connect failed'); };
check('an unreachable server is a network error', await (async () => { const r = await wh.validateWebhookEndpoint(URL_OK, 'x'); return !r.ok && r.code === 'network'; })());

console.log('\nwebhook channel: sending');
calls.length = 0;
answer = () => reply(200, { url: 'https://example.com/posts/42' });
const sent = await wh.sendWebhookPost(creds, { ...post, mediaUrl: 'https://cdn.example.com/a.jpg' });
const body = JSON.parse(calls[0].init.body);
check('a delivered post returns the link the server answered with', sent.ok && sent.url === 'https://example.com/posts/42');
check('the address called is the saved one', calls[0].url === URL_OK);
check('headers carry event, delivery id and agent', calls[0].init.headers['Vane-Event'] === 'post.publish' && calls[0].init.headers['Vane-Delivery'] === post.id && /^Vane-Webhooks/.test(calls[0].init.headers['User-Agent']));
check('the body has the post, its picture and the channel', body.type === 'post.publish' && body.id === post.id && body.data.post.content === 'Hello world' && body.data.post.media[0].url === 'https://cdn.example.com/a.jpg' && body.data.post.media[0].kind === 'image' && body.data.channel.id === 'c1' && body.data.channel.name === 'My server');
check('scheduledAt is an ISO time', body.data.post.scheduledAt === new Date(1_800_000_000 * 1000).toISOString());
{
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(calls[0].init.headers['Vane-Signature']);
  check('the post is signed over the raw body', !!m && m[2] === createHmac('sha256', SECRET).update(`${m[1]}.${calls[0].init.body}`).digest('hex'));
}
calls.length = 0;
await wh.sendWebhookPost(creds, post);
check('a post without media has an empty media list', JSON.parse(calls[0].init.body).data.post.media.length === 0);
answer = () => reply(204, null);
check('an empty 2xx answer is fine and gives no link', await (async () => { const r = await wh.sendWebhookPost(creds, post); return r.ok && r.url === ''; })());
answer = () => reply(200, { url: 'http://insecure.example.com/x' });
check('a link that is not https is ignored', (await wh.sendWebhookPost(creds, post)).url === '');
answer = () => reply(200, { url: 'javascript:alert(1)' });
check('a script link is ignored', (await wh.sendWebhookPost(creds, post)).url === '');
answer = () => reply(200, { url: 'https://user:pw@example.com/x' });
check('a link with a password is ignored', (await wh.sendWebhookPost(creds, post)).url === '');

console.log('\nwebhook channel: failures');
check('429 is retried later and keeps the Retry-After', await (async () => { answer = () => reply(429, null, { 'retry-after': '30' }); const r = await wh.sendWebhookPost(creds, post); return !r.ok && r.retryable && r.retryAfter === 30; })());
check('503 is retried', await (async () => { answer = () => reply(503, null); const r = await wh.sendWebhookPost(creds, post); return !r.ok && r.retryable; })());
check('a network failure is retried', await (async () => { answer = () => { throw new Error('boom'); }; const r = await wh.sendWebhookPost(creds, post); return !r.ok && r.retryable; })());
check('400 is final and quotes the receiver’s message', await (async () => { answer = () => reply(400, { error: 'unknown field' }); const r = await wh.sendWebhookPost(creds, post); return !r.ok && !r.retryable && /unknown field/.test(r.error); })());
check('410 asks to reconnect, no retry', await (async () => { answer = () => reply(410, null); const r = await wh.sendWebhookPost(creds, post); return !r.ok && !r.retryable && /Reconnect/.test(r.error); })());
check('a redirect is final', await (async () => { answer = () => reply(302, null, { location: 'https://x.example.com' }); const r = await wh.sendWebhookPost(creds, post); return !r.ok && !r.retryable; })());
calls.length = 0;
check('a saved address that no longer passes the rules is never called', await (async () => { const r = await wh.sendWebhookPost({ url: 'http://localhost/x', secret: SECRET }, post); return !r.ok && !r.retryable && calls.length === 0; })());
check('text over the limit is refused, nothing is sent', await (async () => { const r = await wh.sendWebhookPost(creds, { ...post, content: 'a'.repeat(10_001) }); return !r.ok && !r.retryable && calls.length === 0; })());
check('nothing to send is refused', await (async () => { const r = await wh.sendWebhookPost(creds, { ...post, content: '   ' }); return !r.ok && calls.length === 0; })());

console.log('\nwebhook channel: saved credentials');
const KEY = 'k'.repeat(40);
const blob = await crypto.encryptToken(JSON.stringify({ type: 'webhook', url: URL_OK, secret: SECRET }), KEY);
check('credentials are read back', JSON.stringify(await wh.loadWebhookCreds(blob, KEY)) === JSON.stringify(creds));
check('a wrong key gives nothing', (await wh.loadWebhookCreds(blob, 'z'.repeat(40))) === null);
check('no key gives nothing', (await wh.loadWebhookCreds(blob, undefined)) === null);
check('an address that fails today’s rules gives nothing', (await wh.loadWebhookCreds(await crypto.encryptToken(JSON.stringify({ url: 'https://127.0.0.1/x', secret: SECRET }), KEY), KEY)) === null);
check('a blob without a secret gives nothing', (await wh.loadWebhookCreds(await crypto.encryptToken(JSON.stringify({ url: URL_OK }), KEY), KEY)) === null);

console.log(`\n${passed} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
