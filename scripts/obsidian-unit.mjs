#!/usr/bin/env node
/** Unit checks for the Obsidian plugin's pure parts (Markdown → post text, API calls, times) and for how Notion/Claude connections are told apart.  npm run test:unit */
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'vane-unit-'));
const load = async (entry, name) => {
  const out = join(dir, `${name}.mjs`);
  await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent' });
  return import(pathToFileURL(out).href);
};
const convert = await load('integrations/obsidian/src/convert.ts', 'convert');
const api = await load('integrations/obsidian/src/api.ts', 'api');
const integ = await load('functions/api/lib/integrations.ts', 'integrations');
const oauth = await load('functions/api/lib/oauth.ts', 'oauth');
rmSync(dir, { recursive: true, force: true });

let passed = 0;
const failed = [];
const check = (name, cond) => { if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed.push(name); console.log(`  ✗ ${name}`); } };
const post = (md, o) => convert.noteToPost(md, o);

console.log('\nMarkdown → post text');
check('properties block is removed', post('---\ntitle: A\ntags: [x]\n---\nHello') === 'Hello');
check('properties stay when the option is off', post('---\na: 1\n---\nHi', { stripFrontmatter: false, plainText: false }).startsWith('---'));
check('headings lose their #', post('# Title\n\n## Part\ntext') === 'Title\n\nPart\ntext');
check('bold, italics, strike and highlight markers go', post('**b** __b2__ *i* _i2_ ~~s~~ ==h==') === 'b b2 i i2 s h');
check('snake_case words and 2*3*4 are not italics', post('use snake_case_name and 2*3*4') === 'use snake_case_name and 2*3*4');
check('wikilinks keep the alias or the page name', post('[[Page|alias]] and [[Other#Part]] and [[Plain]]') === 'alias and Other and Plain');
check('embeds and images are dropped', post('a ![[pic.png]] b ![alt](x.png) c') === 'a  b  c');
check('web links are written out, plain URLs stay', post('[site](https://vaneapp.dev) and [https://x.io](https://x.io)') === 'site (https://vaneapp.dev) and https://x.io');
check('hashtags and mentions stay', post('Launch day #buildinpublic @vane') === 'Launch day #buildinpublic @vane');
check('bullets and tasks become symbols', post('- one\n* two\n- [x] done\n- [ ] todo') === '• one\n• two\n✓ done\n• todo');
check('numbered lists stay', post('1. a\n2. b') === '1. a\n2. b');
check('quotes and callouts lose their markers', post('> quote\n> [!tip] Title\n> body') === 'quote\nTitle\nbody');
check('comments are removed', post('a %%secret%% b <!-- note --> c') === 'a  b  c');
check('code keeps its text, not its fences or markdown', post('```js\nconst **a** = 1\n```\nand `x_y`') === 'const **a** = 1\nand x_y');
check('rules, footnotes and block ids go', post('a ^id1\n\n---\n\nb[^1]\n\n[^1]: note') === 'a\n\nb');
check('blank lines are collapsed and trimmed', post('\n\na  \n\n\n\nb \n\n') === 'a\n\nb');
check('plain text off keeps the Markdown', post('# T\n**b**', { stripFrontmatter: true, plainText: false }) === '# T\n**b**');

console.log('\ntalking to the API');
check('address: trailing slash cut, http only on localhost', api.cleanBase('https://vaneapp.dev/') === 'https://vaneapp.dev' && api.cleanBase('http://evil.com') === null && api.cleanBase('http://localhost:8788') === 'http://localhost:8788' && api.cleanBase('nonsense') === null);
check('key shape is checked', api.keyProblem('') !== null && api.keyProblem('sk-123') !== null && api.keyProblem('cpost_live_abcdefgh1234') === null && api.keyProblem('cpost_test_abcdefgh1234') === null);
const calls = [];
const http = (answer) => async (req) => { calls.push(req); return answer(req); };
const chans = await api.listChannels(http(() => ({ status: 200, json: { ok: true, channels: [{ id: 'a', platform: 'telegram', name: 'My TG', isActive: true }, { id: 'b', platform: 'x', isActive: false }, { nope: 1 }] } })), 'https://v.dev', 'cpost_live_abcdefgh1234');
check('channels are listed and junk is skipped', chans.length === 2 && chans[0].name === 'My TG' && chans[1].name === 'x' && chans[1].isActive === false);
check('the key goes in a Bearer header to /api/v1/channels', calls[0].url === 'https://v.dev/api/v1/channels' && calls[0].headers.Authorization === 'Bearer cpost_live_abcdefgh1234');
calls.length = 0;
const made = await api.createPost(http(() => ({ status: 201, json: { ok: true, groupId: 'g', scheduledAt: 1800000000, posts: [{}, {}], test: true } })), 'https://v.dev', 'cpost_test_abcdefgh1234', { content: 'Hi', channelIds: ['a', 'b'], scheduledAt: '2026-11-02T09:00:00.000Z' }, 'idem-1');
check('a post is sent with its body and an idempotency key', calls[0].url === 'https://v.dev/api/v1/posts' && calls[0].headers['Idempotency-Key'] === 'idem-1' && JSON.parse(calls[0].body).channelIds.length === 2 && JSON.parse(calls[0].body).content === 'Hi');
check('the answer is read (test mode, count, time)', made.test === true && made.channels === 2 && made.scheduledAt === 1800000000);
const err = async (status, json) => { try { await api.createPost(http(() => ({ status, json })), 'https://v.dev', 'cpost_live_abcdefgh1234', { content: 'x', channelIds: ['a'], scheduledAt: 'z' }, 'i'); return null; } catch (e) { return e; } };
const e401 = await err(401, { ok: false, error: 'bad' }), e402 = await err(402, { ok: false, code: 'quota_exceeded', error: 'No API posts left.' }), e422 = await err(422, { ok: false, code: 'profanity', error: 'Please remove the rude word.' }), e500 = await err(500, null);
check('401 asks to check the key', e401 instanceof api.VaneError && /API key/.test(e401.message));
check('402 keeps the quota code and message', e402.code === 'quota_exceeded' && /No API posts left/.test(e402.message));
check('the server\'s own message is shown for other errors', e422.message === 'Please remove the rude word.' && e422.code === 'profanity');
check('an empty error body still gives a readable message', /500/.test(e500.message));

console.log('\nwhen to post');
const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);
const soon = api.whenToIso('soon', '', NOW);
check('"as soon as possible" is 90 seconds ahead', soon.iso === new Date(NOW + 90_000).toISOString());
check('an empty time is refused', 'error' in api.whenToIso('at', '', NOW));
check('a time in the past or within a minute is refused', 'error' in api.whenToIso('at', '2026-10-30T11:00', NOW) && 'error' in api.whenToIso('at', new Date(NOW + 30_000).toISOString().slice(0, 16), NOW));
check('more than a year ahead is refused', 'error' in api.whenToIso('at', '2028-01-01T10:00', NOW));
check('a good local time becomes an ISO time', 'iso' in api.whenToIso('at', '2026-11-02T09:30', NOW));

console.log('\nNotion and Obsidian as integrations');
check('both are known integrations with names', integ.isIntegrationId('notion') && integ.isIntegrationId('obsidian') && integ.INTEGRATION_NAMES.notion === 'Notion' && integ.INTEGRATION_NAMES.obsidian === 'Obsidian plugin');
const cat = integ.catalog('https://vaneapp.dev');
check('the catalog has a card for each, and every id has one', ['notion', 'obsidian'].every((id) => cat.some((c) => c.id === id)) && integ.INTEGRATION_IDS.every((id) => cat.some((c) => c.id === id)));
check('Notion points at the same MCP address as Claude', cat.find((c) => c.id === 'notion').endpoints[0].value === 'https://vaneapp.dev/api/v1/mcp');
check('Obsidian offers the plugin download', cat.find((c) => c.id === 'obsidian').endpoints.some((e) => e.value === 'https://vaneapp.dev/downloads/vane-for-obsidian.zip'));
check('requests are told apart by User-Agent and key name', integ.inferIntegration('Vane-Obsidian/1.0 (obsidian)', 'k') === 'obsidian' && integ.inferIntegration(null, 'My Notion agent') === 'notion' && integ.inferIntegration('Mozilla', 'Notion connector') === 'notion' && integ.inferIntegration(null, 'Claude connector') === 'claude' && integ.inferIntegration(null, 'plain') === null);
check('a Notion client gets the Notion connector', oauth.connectorFor('Notion', ['https://www.notion.so/mcp/oauth/callback']).integration === 'notion');
check('the address decides when the name says nothing', oauth.connectorFor('MCP Client', ['https://mcp.notion.com/cb']).integration === 'notion');
const claude = oauth.connectorFor('Claude', ['https://claude.ai/api/mcp/auth_callback']);
check('Claude and anything unknown stay Claude, with the old key name', claude.integration === 'claude' && claude.keyName === 'Claude connector' && oauth.connectorFor('Something else', ['http://localhost:3118/cb']).integration === 'claude');
check('a look-alike host is not Notion', oauth.connectorFor('x', ['https://notion.so.evil.com/cb']).integration === 'claude' && oauth.connectorFor('x', ['https://evilnotion.so/cb']).integration === 'claude');
const outer = new Request('https://x.dev/api/v1/mcp'), other = new Request('https://x.dev/api/v1/mcp');
integ.markMcpClient(outer, 'notion');
check('an MCP call remembers its client, default Claude', integ.mcpClientOf(outer) === 'notion' && integ.mcpClientOf(other) === 'claude');

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
