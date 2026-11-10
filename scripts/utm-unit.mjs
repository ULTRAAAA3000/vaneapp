#!/usr/bin/env node
/**
 * Tagging links with utm_source=<network> (functions/api/lib/utm.ts).   npm run test:unit
 */
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'vane-unit-'));
const out = join(dir, 'utm.mjs');
await build({ entryPoints: ['functions/api/lib/utm.ts'], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent' });
const { tagLinks, tagUrl } = await import(pathToFileURL(out).href);
rmSync(dir, { recursive: true, force: true });

let passed = 0;
const failed = [];
const check = (name, cond, extra = '') => { if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed.push(name); console.log(`  ✗ ${name} ${extra}`); } };
const eq = (name, got, want) => check(name, got === want, `\n      got:  ${got}\n      want: ${want}`);

eq('a plain link', tagLinks('Read https://example.com/blog now', 'bluesky'), 'Read https://example.com/blog?utm_source=bluesky&utm_medium=social now');
eq('a link that has a query keeps it', tagUrl('https://example.com/p?id=7', 'telegram'), 'https://example.com/p?id=7&utm_source=telegram&utm_medium=social');
eq('a #fragment stays at the end', tagUrl('https://example.com/p#top', 'mastodon'), 'https://example.com/p?utm_source=mastodon&utm_medium=social#top');
eq('the full stop after a link is not part of it', tagLinks('See https://example.com/a.', 'slack'), 'See https://example.com/a?utm_source=slack&utm_medium=social.');
eq('a link in brackets', tagLinks('(https://example.com/a)', 'discord'), '(https://example.com/a?utm_source=discord&utm_medium=social)');
eq('a link that already has utm_source is left alone', tagLinks('https://example.com/?utm_source=newsletter', 'bluesky'), 'https://example.com/?utm_source=newsletter');
eq('an existing utm_medium is kept', tagUrl('https://example.com/?utm_medium=email', 'devto'), 'https://example.com/?utm_medium=email&utm_source=devto');
eq('every link in the text', tagLinks('a https://a.com b http://b.com/x?y=1', 'threads'), 'a https://a.com/?utm_source=threads&utm_medium=social b http://b.com/x?y=1&utm_source=threads&utm_medium=social');
eq('text without links is unchanged', tagLinks('No links, just #tags and an email a@b.com', 'x'), 'No links, just #tags and an email a@b.com');
eq('a broken link is left as it is', tagLinks('https://', 'x'), 'https://');
check('the source name is escaped', tagUrl('https://example.com', 'a b&c').includes('utm_source=a%20b%26c'));

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
