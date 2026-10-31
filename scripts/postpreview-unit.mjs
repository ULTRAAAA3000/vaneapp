#!/usr/bin/env node
/**
 * Unit checks for the public post preview (vaneapp.dev/p/<token>): the picture it may show, how names are joined, that everything
 * from a person is escaped, what the link preview says, and what the route answers. No server needed:  npm run test:unit
 */
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'vane-unit-'));
const out = join(dir, 'postpreview.mjs');
await build({ entryPoints: ['functions/api/lib/postpreview.ts'], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent' });
const pp = await import(pathToFileURL(out).href);
rmSync(dir, { recursive: true, force: true });

let passed = 0;
const failed = [];
const check = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed.push(name); console.log(`  ✗ ${name} ${extra}`); }
};

const UUID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const SITE = 'https://vaneapp.dev';
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUv';   // 22 characters, like the real ones

console.log('\nnetwork names');
check('one name', pp.joinNames(['Telegram']) === 'Telegram');
check('two names', pp.joinNames(['Telegram', 'Bluesky']) === 'Telegram and Bluesky');
check('three names', pp.joinNames(['Telegram', 'Bluesky', 'Mastodon']) === 'Telegram, Bluesky and Mastodon');
check('no names gives an empty string', pp.joinNames([]) === '');
check('known networks have their proper name', pp.networkName('devto') === 'Dev.to' && pp.networkName('linkedin') === 'LinkedIn');
check('an unknown network shows its id', pp.networkName('somethingnew') === 'somethingnew');

console.log('\nthe picture');
const img = (v) => JSON.stringify(v);
check('one of our uploaded files is shown', pp.previewImage(img([`${UUID}.jpg`]), SITE) === `${SITE}/api/media/${UUID}.jpg`);
check('an https image address is shown', pp.previewImage(img(['https://cdn.example.com/a/b.png']), SITE) === 'https://cdn.example.com/a/b.png');
check('a video is not shown as a picture', pp.previewImage(img([`${UUID}.mp4`]), SITE) === null && pp.previewImage(img(['https://cdn.example.com/v.mp4']), SITE) === null);
check('an address that is not an image is not shown', pp.previewImage(img(['https://cdn.example.com/page']), SITE) === null);
check('plain http is not shown', pp.previewImage(img(['http://cdn.example.com/a.png']), SITE) === null);
check('an address with a login in it is not shown', pp.previewImage(img(['https://user:pass@cdn.example.com/a.png']), SITE) === null);
check('a javascript: address is not shown', pp.previewImage(img(['javascript:alert(1)//.png']), SITE) === null);
check('a key that is not one of ours is not shown', pp.previewImage(img(['../../etc/passwd.jpg']), SITE) === null);
check('no media gives nothing', pp.previewImage('[]', SITE) === null && pp.previewImage('not json', SITE) === null && pp.previewImage(img([42]), SITE) === null);
check('an own file needs the site address', pp.previewImage(img([`${UUID}.jpg`]), '') === null);

console.log('\nthe page');
const base = {
  text: 'Launching today!\nSecond line', image: null, sentAt: 1793500000, address: `${SITE}/p/${TOKEN}`, site: SITE,
  networks: [{ name: 'Telegram', url: 'https://t.me/vane/12' }, { name: 'Bluesky', url: null }, { name: 'Mastodon', url: null }],
};
const html = pp.renderPreview(base);
check('it is a full HTML page', html.startsWith('<!DOCTYPE html>') && html.includes('</html>'));
check('the post text is there', html.includes('Launching today!\nSecond line'));
check('it says where the post went', html.includes('Telegram, Bluesky and Mastodon'));
check('it counts the networks', html.includes('3 networks'));
check('one network is not "1 networks"', pp.renderPreview({ ...base, networks: [base.networks[0]] }).includes('one network') && !pp.renderPreview({ ...base, networks: [base.networks[0]] }).includes('1 networks'));
check('it shows the date in UTC', /Published <time datetime="2026-11-01T02:26:40.000Z">2026-11-01 02:26 UTC<\/time>/.test(html), html.match(/Published <time[^]*?<\/time>/)?.[0]);
check('there is a Try Vane Free button that goes to sign-up', (html.match(/Try Vane Free<\/a>/g) || []).length === 2 && html.includes(`href="${SITE}/login?mode=register"`));
check('a network with a link is a link that opens safely', html.includes('href="https://t.me/vane/12" target="_blank" rel="noopener noreferrer nofollow"'));
check('a network without a link is plain text', (html.match(/<a class="chip"/g) || []).length === 1);
check('it is not indexed and sends no referrer', html.includes('<meta name="robots" content="noindex, nofollow"') && html.includes('<meta name="referrer" content="no-referrer"'));
check('it has no scripts', !/<script/i.test(html));
check('the link preview names the networks', html.includes('<meta property="og:title" content="A post published with Vane on Telegram, Bluesky and Mastodon"'));
check('the link preview has the canonical address', html.includes(`<link rel="canonical" href="${SITE}/p/${TOKEN}"`) && html.includes(`<meta property="og:url" content="${SITE}/p/${TOKEN}"`));
check('without a picture the preview uses the Vane image and a small card', html.includes(`og:image" content="${SITE}/assets/og.png"`) && html.includes('twitter:card" content="summary"'));
check('with a picture it is shown and used for the preview', (() => {
  const h = pp.renderPreview({ ...base, image: `${SITE}/api/media/${UUID}.jpg` });
  return h.includes(`<img class="img" src="${SITE}/api/media/${UUID}.jpg"`) && h.includes(`og:image" content="${SITE}/api/media/${UUID}.jpg"`) && h.includes('summary_large_image');
})());
check('a very long text is cut', pp.renderPreview({ ...base, text: 'a'.repeat(50000) }).length < 30000);
check('the description is one short line', /name="description" content="[^"\n]{0,200}"/.test(pp.renderPreview({ ...base, text: 'x\n\n y '.repeat(200) })));

console.log('\nsafety');
const evil = pp.renderPreview({
  ...base, text: '<script>alert(1)</script> "><img src=x onerror=alert(2)> \'',
  image: 'https://cdn.example.com/a.png" onerror="alert(4)',
  networks: [{ name: '<b>x</b>', url: 'https://t.me/a"onmouseover="alert(3)' }],
});
check('markup in the text is escaped', !evil.includes('<script>alert(1)') && evil.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
check('a quote cannot break out of an attribute', !evil.includes('"onmouseover="') && !evil.includes('" onerror="') && !evil.includes('<img src=x'));
check('a network name is escaped', !evil.includes('<b>x</b>') && evil.includes('&lt;b&gt;x&lt;/b&gt;'));
check('the text in the link preview is escaped', !/name="description" content="[^"]*</.test(evil));

console.log('\nthe route');
let views = 0;
const stub = (rows) => ({ ENCRYPTION_KEY: 'k', DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: rows }), first: async () => null, run: async () => { views++; return {}; } }) }) } });
const req = new Request(`${SITE}/p/${TOKEN}`);
const live = [{ content: 'Hello <world>', media_keys: '[]', sent_at: 1793500000, scheduled_at: 1793500000, external_id: null, channel_id: 'c1', type: 'mastodon', credentials: '' }];
let r = await pp.previewPage(stub(live), req, TOKEN);
const body = await r.text();
check('a live link answers 200 with the page', r.status === 200 && body.includes('Hello &lt;world&gt;'));
check('the headers keep it private and locked down', /noindex/.test(r.headers.get('x-robots-tag')) && r.headers.get('x-content-type-options') === 'nosniff' && /default-src 'none'/.test(r.headers.get('content-security-policy')) && /frame-ancestors 'none'/.test(r.headers.get('content-security-policy')));
r = await pp.previewPage(stub([]), req, TOKEN);
check('a link that was switched off answers 404', r.status === 404 && (await r.text()).includes('not available'));
for (const bad of ['', 'short', '../../admin', 'a'.repeat(23), 'AbCdEfGhIjKlMnOpQrSt%v']) {
  r = await pp.previewPage(stub(live), req, bad);
  check(`a malformed address "${bad.slice(0, 12)}" answers 404 without touching the database`, r.status === 404);
}

console.log('\nsharing a post');
const sdb = (rows) => ({ ENCRYPTION_KEY: 'k', DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: rows }), first: async () => null, run: async () => ({}) }) }) } });
r = await pp.sharePost(sdb([]), req, 'u1', 'not-a-uuid');
check('a group id that is not an id is refused', r.status === 400);
r = await pp.sharePost(sdb([]), req, 'u1', UUID);
check('a post that was not published (or is not yours) cannot be shared', r.status === 404);
r = await pp.sharePost(sdb([]), req, 'u1', undefined);
check('a missing group id is refused', r.status === 400);

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
