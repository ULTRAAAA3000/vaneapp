#!/usr/bin/env node
/**
 * Unit checks for the landing page's social links: which addresses and texts the admin may save.
 * No server needed:  npm run test:unit
 */
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'vane-unit-'));
const out = join(dir, 'socials.mjs');
await build({ entryPoints: ['functions/api/lib/socials.ts'], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent' });
const lib = await import(pathToFileURL(out).href);
rmSync(dir, { recursive: true, force: true });

let passed = 0;
const failed = [];
const check = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed.push(name); console.log(`  ✗ ${name} ${extra}`); }
};

console.log('\nlinks: addresses');
for (const u of ['https://t.me/vanenews', 'https://bsky.app/profile/vaneapp.bsky.social', 'https://mastodon.social/@vaneapp', 'https://youtube.com/@vaneapp?sub=1'])
  check(`accepts ${u}`, lib.cleanUrl(u) === u);
check('trims spaces', lib.cleanUrl('  https://t.me/vanenews  ') === 'https://t.me/vanenews');
check('normalises a bare host', lib.cleanUrl('https://example.com') === 'https://example.com/');
for (const [u, why] of Object.entries({
  'http://t.me/vanenews': 'plain http',
  'javascript:alert(1)': 'a script address',
  'data:text/html,<script>1</script>': 'a data address',
  'ftp://example.com/a': 'another scheme',
  'https://user:pw@example.com/a': 'credentials in the address',
  'https://localhost/a': 'a host without a dot',
  '//t.me/vanenews': 'no scheme',
  't.me/vanenews': 'no scheme at all',
  '': 'empty',
  ['https://example.com/' + 'a'.repeat(300)]: 'too long',
})) check(`rejects ${why}`, lib.cleanUrl(u) === null);
check('rejects a non-string', lib.cleanUrl(42) === null && lib.cleanUrl(null) === null);

console.log('\nlinks: fields');
const ok = { network: 'telegram', name: 'Telegram', url: 'https://t.me/vanenews' };
check('a minimal link is valid', lib.validateSocialInput(ok, true).ok === true);
check('every listed network is accepted', lib.NETWORKS.every((n) => lib.validateSocialInput({ ...ok, network: n.id }, true).ok));
check('an unknown network is refused', !lib.validateSocialInput({ ...ok, network: 'myspace' }, true).ok);
check('name and url are required when creating', !lib.validateSocialInput({ network: 'x', url: ok.url }, true).ok && !lib.validateSocialInput({ network: 'x', name: 'X' }, true).ok);
check('an edit may change a single field', lib.validateSocialInput({ handle: '@vane' }, false).ok === true);
check('an edit cannot blank the name', !lib.validateSocialInput({ name: '   ' }, false).ok);
check('a multi-line description is refused', !lib.validateSocialInput({ ...ok, description: 'a\nb' }, true).ok);
check('a control character is refused', !lib.validateSocialInput({ ...ok, handle: 'a\u0000b' }, true).ok);
check('length limits: name 40, handle 60, description 160, button 30',
  lib.validateSocialInput({ ...ok, name: 'n'.repeat(40), handle: 'h'.repeat(60), description: 'd'.repeat(160), ctaLabel: 'c'.repeat(30) }, true).ok
  && !lib.validateSocialInput({ ...ok, name: 'n'.repeat(41) }, true).ok && !lib.validateSocialInput({ ...ok, handle: 'h'.repeat(61) }, true).ok
  && !lib.validateSocialInput({ ...ok, description: 'd'.repeat(161) }, true).ok && !lib.validateSocialInput({ ...ok, ctaLabel: 'c'.repeat(31) }, true).ok);
check('order must be a whole number', lib.validateSocialInput({ sort: 5 }, false).ok && !lib.validateSocialInput({ sort: 1.5 }, false).ok && !lib.validateSocialInput({ sort: '5' }, false).ok);
check('isPublic must be a boolean', lib.validateSocialInput({ isPublic: false }, false).ok && !lib.validateSocialInput({ isPublic: 'no' }, false).ok);
check('markup is kept as plain text (it is escaped when shown)', lib.validateSocialInput({ ...ok, name: '<b>x</b>' }, true).value.name === '<b>x</b>');

console.log('\nsection text');
check('heading, label and intro are valid', lib.validateSection({ eyebrow: 'Follow', title: 'Follow Vane', intro: 'News.' }).ok);
check('label and intro may be empty (they are hidden)', lib.validateSection({ eyebrow: '', title: 'Follow Vane', intro: '' }).ok);
check('the heading is required', !lib.validateSection({ eyebrow: '', title: '  ', intro: '' }).ok);
check('limits: label 40, heading 120, intro 300', !lib.validateSection({ eyebrow: 'e'.repeat(41), title: 't', intro: '' }).ok && !lib.validateSection({ eyebrow: '', title: 't'.repeat(121), intro: '' }).ok && !lib.validateSection({ eyebrow: '', title: 't', intro: 'i'.repeat(301) }).ok);
check('a missing field is refused', !lib.validateSection({ title: 'x' }).ok);

console.log('\nids');
check('a new id is <network>-<6 hex>', /^x-[0-9a-f]{6}$/.test(lib.newLinkId('x')));
check('ids differ', lib.newLinkId('x') !== lib.newLinkId('x'));
check('the missing-table check recognises the D1 message', lib.isMissingTable(new Error('D1_ERROR: no such table: social_links: SQLITE_ERROR')) && !lib.isMissingTable(new Error('boom')));

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) { console.log('Failed:\n  - ' + failed.join('\n  - ')); process.exit(1); }
