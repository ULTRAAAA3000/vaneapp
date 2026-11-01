#!/usr/bin/env node
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'vane-unit-'));
const out = join(dir, 'pinterest.mjs');
await build({ entryPoints: ['functions/api/channels/pinterest.ts'], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent' });
const pn = await import(pathToFileURL(out).href);
rmSync(dir, { recursive: true, force: true });

let passed = 0;
const failed = [];
const check = (name, cond) => { if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed.push(name); console.log(`  ✗ ${name}`); } };

const calls = [];
let answer = () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return answer(String(url), init); };
const reply = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const creds = { username: 'anna', boardId: '123', boardName: 'Recipes', accessToken: 'tok', refreshToken: 'ref', expiresAt: 9e9 };

console.log('\npinterest: text');
const sp = pn.splitPin('Soup in 10 minutes\n\nThe easiest soup, see https://example.com/soup now');
check('first line is the title', sp.title === 'Soup in 10 minutes');
check('the rest is the description', sp.description.startsWith('The easiest soup'));
check('the first https link is the destination', sp.link === 'https://example.com/soup');
check('no link when there is none', pn.splitPin('Only a title').link === null);
check('board name is cleaned', pn.cleanBoard('  My boards  ') === 'My boards' && pn.cleanBoard('') === null && pn.cleanBoard(5) === null);

console.log('\npinterest: sending');
check('a pin without a picture is refused, nothing is sent', await (async () => { calls.length = 0; const r = await pn.sendPinterestPin(creds, 'Title', undefined); return !r.ok && !r.retryable && calls.length === 0; })());
check('a video is refused', (await pn.sendPinterestPin(creds, 'Title', 'https://x.test/a.mp4')).ok === false);
check('a title over 100 characters is refused', (await pn.sendPinterestPin(creds, 'a'.repeat(101), 'https://x.test/a.jpg')).ok === false);
calls.length = 0;
answer = () => reply(201, { id: '987654321' });
const ok = await pn.sendPinterestPin(creds, 'Soup\n\nGood https://example.com/soup', 'https://x.test/a.jpg');
const sent = JSON.parse(calls[0].init.body);
check('a pin is created and its address returned', ok.ok && ok.url === 'https://www.pinterest.com/pin/987654321/');
check('the request carries board, title, link and image', sent.board_id === '123' && sent.title === 'Soup' && sent.link === 'https://example.com/soup' && sent.media_source.url === 'https://x.test/a.jpg');
check('the token goes in a header', calls[0].init.headers.Authorization === 'Bearer tok');
check('429 is retried later', await (async () => { answer = () => reply(429, {}, { 'retry-after': '30' }); const r = await pn.sendPinterestPin(creds, 'T', 'https://x.test/a.jpg'); return !r.ok && r.retryable && r.retryAfter === 30; })());
check('500 is retried', await (async () => { answer = () => reply(500, {}); const r = await pn.sendPinterestPin(creds, 'T', 'https://x.test/a.jpg'); return !r.ok && r.retryable; })());
check('401 asks to reconnect, no retry', await (async () => { answer = () => reply(401, {}); const r = await pn.sendPinterestPin(creds, 'T', 'https://x.test/a.jpg'); return !r.ok && !r.retryable && /Reconnect/.test(r.error); })());
check('a missing board is explained', await (async () => { answer = () => reply(404, {}); const r = await pn.sendPinterestPin(creds, 'T', 'https://x.test/a.jpg'); return !r.ok && /Recipes/.test(r.error); })());

console.log('\npinterest: boards and tokens');
answer = () => reply(200, { items: [{ id: '1', name: 'Travel' }, { id: '123', name: 'Recipes' }] });
const b = await pn.findBoard('tok', 'recipes');
check('a board is found by name, ignoring case', b.ok && b.id === '123');
check('an unknown board is reported', (await pn.findBoard('tok', 'nope')).reason === 'noboard');
answer = () => reply(200, { access_token: 'new', expires_in: 100 });
const rf = await pn.refreshPinterestToken({ PINTEREST_APP_ID: 'a', PINTEREST_APP_SECRET: 'b' }, creds, 1000);
check('a refresh keeps the old refresh token when no new one comes', rf.ok && rf.creds.accessToken === 'new' && rf.creds.refreshToken === 'ref' && rf.creds.expiresAt === 1100);
answer = () => reply(400, { code: 7 });
check('a refused refresh is a revoked sign-in', (await pn.refreshPinterestToken({}, creds, 1000)).revoked === true);
check('the app is configured only with both keys', pn.pinterestConfigured({ PINTEREST_APP_ID: 'a' }) === false && pn.pinterestConfigured({ PINTEREST_APP_ID: 'a', PINTEREST_APP_SECRET: 'b' }) === true);
check('the sign-in address asks for pin and board access', /pins%3Awrite|pins:write/.test(pn.authorizeUrl({ PINTEREST_APP_ID: 'a' }, 'https://x.test/cb', 's')));

console.log(`\n${passed} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
