#!/usr/bin/env node
/**
 * Unit checks for the Slack and Hashnode channels (mocked network).
 * No server needed:  npm run test:unit
 */
import { build } from 'esbuild';
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
const sk = await bundle('functions/api/channels/slack.ts', 'slack.mjs');
const hn = await bundle('functions/api/channels/hashnode.ts', 'hashnode.mjs');
const link = await bundle('functions/api/lib/postlink.ts', 'postlink.mjs');
rmSync(dir, { recursive: true, force: true });

let passed = 0;
const failed = [];
const check = (name, cond, extra = '') => { if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed.push(name); console.log(`  ✗ ${name} ${extra}`); } };

const calls = [];
let answer = () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return answer(String(url), init); };
const reply = (status, body, headers = {}) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const HOST = ['https:', '', 'hooks.slack', 'com'].join('/').replace('slack/com', 'slack.com');
const HOOK = `${HOST}/services/T0123ABCD/B0123ABCD/` + ['abcd', 'EFGH', '1234', 'abcd', 'EFGH', '1234'].join('');
console.log('\nslack: address');
check('a real webhook is accepted', sk.normalizeSlackWebhook(` ${HOOK} `)?.url === HOOK);
for (const bad of ['http://hooks.slack.com/services/T1/B1/x', 'https://hooks.slack.com.evil.com/services/T0123ABCD/B0123ABCD/abc', 'https://example.com/services/T0123ABCD/B0123ABCD/abc', 'https://hooks.slack.com/services/T0123ABCD', '', 5, null]) {
  check(`refused: ${JSON.stringify(bad)}`, sk.normalizeSlackWebhook(bad) === null);
}
console.log('\nslack: connecting');
calls.length = 0;
answer = () => reply(400, { error: 'no_text' });
check('400 from an empty probe means the webhook is live', (await sk.validateSlackWebhook(HOOK)).ok === true && calls.length === 1);
answer = () => reply(404, null);
check('404 means deleted', (await sk.validateSlackWebhook(HOOK)).code === 'bad_hook');
answer = () => reply(429, null);
check('429 is rate limited', (await sk.validateSlackWebhook(HOOK)).code === 'rate_limited');
calls.length = 0;
check('a bad address makes no call', (await sk.validateSlackWebhook('nope')).code === 'bad_url' && calls.length === 0);

console.log('\nslack: sending');
{
  const p = sk.slackPayload('Hi <!channel> & <@U1>');
  check('mentions and markup are escaped', p.text === 'Hi &lt;!channel&gt; &amp; &lt;@U1&gt;');
  const q = sk.slackPayload('Hello', 'https://cdn.example.com/a.png');
  check('an image adds blocks', Array.isArray(q.blocks) && q.blocks.length === 2);
}
const sc = { webhookUrl: HOOK, webhookId: 'T0123ABCD/B0123ABCD' };
calls.length = 0; answer = () => new Response('ok', { status: 200 });
check('a post is sent', (await sk.sendSlackPost(sc, 'Hello')).ok === true && calls[0].url === HOOK);
answer = () => reply(429, null, { 'retry-after': '7' });
{ const r = await sk.sendSlackPost(sc, 'Hello'); check('429 retries', !r.ok && r.retryable && r.retryAfter === 7); }
answer = () => reply(503, null);
check('5xx retries', (await sk.sendSlackPost(sc, 'Hello')).retryable === true);
answer = () => reply(410, null);
check('a deleted webhook fails for good', (await sk.sendSlackPost(sc, 'Hello')).retryable === false);
calls.length = 0;
check('too long text is refused without a call', (await sk.sendSlackPost(sc, 'x'.repeat(3001))).ok === false && calls.length === 0);
check('empty text is refused', (await sk.sendSlackPost(sc, '  ')).ok === false);

const KEY = 'a1b2c3d4-e5f6-4a7b-8c9d-0123456789ab';
const PUB = 'a'.repeat(24);
const PUB2 = 'b'.repeat(24);
const me = (pubs) => ({ data: { me: { username: 'artem', publications: { edges: pubs.map(([id, url]) => ({ node: { id, title: 'Blog', url } })) } } } });
console.log('\nhashnode: connecting');
calls.length = 0;
check('a bad token makes no call', (await hn.validateHashnodeKey('x')).code === 'bad_key' && calls.length === 0);
answer = () => reply(200, me([[PUB, 'https://artem.hashnode.dev']]));
{
  const r = await hn.validateHashnodeKey(KEY);
  check('a single blog is picked', r.ok && r.publication.id === PUB && r.username === 'artem');
  check('the token goes in the Authorization header', calls.at(-1).init.headers.Authorization === KEY);
}
answer = () => reply(200, me([[PUB, 'https://artem.hashnode.dev'], [PUB2, 'https://other.example.com']]));
check('several blogs need an address', (await hn.validateHashnodeKey(KEY)).code === 'bad_blog');
check('the address picks the blog', (await hn.validateHashnodeKey(KEY, 'https://other.example.com/')).publication?.id === PUB2);
check('an unknown address is refused', (await hn.validateHashnodeKey(KEY, 'nope.example.com')).code === 'bad_blog');
answer = () => reply(200, { data: { me: null }, errors: [{ message: 'x' }] });
check('no user means a bad token', (await hn.validateHashnodeKey(KEY)).code === 'bad_key');
answer = () => reply(401, null);
check('401 means a bad token', (await hn.validateHashnodeKey(KEY)).code === 'bad_key');
answer = () => reply(200, me([]));
check('no blog is explained', (await hn.validateHashnodeKey(KEY)).code === 'bad_blog');

console.log('\nhashnode: article');
check('first line is the title', JSON.stringify(hn.articleFromPost('# Title\n\nBody text')) === JSON.stringify({ title: 'Title', body: 'Body text' }));
check('a title alone is also the body', hn.articleFromPost('Only').body === 'Only');
check('a long title is cut', hn.articleFromPost('word '.repeat(60)).title.length <= 150);
check('empty text has no title', hn.articleFromPost('  \n ').title === '');

console.log('\nhashnode: sending');
const hc = { apiKey: KEY, publicationId: PUB, host: 'artem.hashnode.dev', username: 'artem' };
answer = () => reply(200, { data: { publishPost: { post: { id: 'p1', url: 'https://artem.hashnode.dev/t' } } } });
calls.length = 0;
{
  const r = await hn.sendHashnodePost(hc, 'Title\nBody', 'https://cdn.example.com/a.png');
  const v = JSON.parse(calls[0].init.body).variables.input;
  check('an article is published', r.ok && r.url === 'https://artem.hashnode.dev/t');
  check('the input carries title, body, blog and cover', v.title === 'Title' && v.contentMarkdown === 'Body' && v.publicationId === PUB && v.coverImageOptions.coverImageURL === 'https://cdn.example.com/a.png');
}
answer = () => reply(200, { errors: [{ message: 'no', extensions: { code: 'UNAUTHENTICATED' } }] });
check('a revoked token fails for good', (await hn.sendHashnodePost(hc, 'T\nB')).retryable === false);
answer = () => reply(200, { errors: [{ message: 'slow', extensions: { code: 'TOO_MANY_REQUESTS' } }] });
check('rate limit retries', (await hn.sendHashnodePost(hc, 'T\nB')).retryable === true);
answer = () => reply(502, null);
check('5xx retries', (await hn.sendHashnodePost(hc, 'T\nB')).retryable === true);
answer = () => reply(200, { data: { publishPost: { post: null } } });
check('a reply without an address fails', (await hn.sendHashnodePost(hc, 'T\nB')).ok === false);
calls.length = 0;
check('empty text is refused without a call', (await hn.sendHashnodePost(hc, ' ')).ok === false && calls.length === 0);

console.log('\npost links');
check('slack has no link', link.postUrl('slack', null) === null);
check('hashnode links to the article', link.postUrl('hashnode', 'https://artem.hashnode.dev/t') === 'https://artem.hashnode.dev/t');

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) { console.log('Failed:', failed.join('; ')); process.exit(1); }
