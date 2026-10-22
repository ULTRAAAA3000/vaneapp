#!/usr/bin/env node
/**
 * Unit checks for the Library helpers: file names and the "is this file still needed by an unsent post" lookup.
 * No server needed:  npm run test:unit
 */
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'vane-unit-'));
const out = join(dir, 'library.mjs');
await build({ entryPoints: ['functions/api/lib/library.ts'], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent' });
const lib = await import(pathToFileURL(out).href);
rmSync(dir, { recursive: true, force: true });

let passed = 0;
const failed = [];
const check = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed.push(name); console.log(`  ✗ ${name} ${extra}`); }
};

console.log('\nfile names');
check('a plain name stays', lib.cleanFileName('Summer photo.png', 'x') === 'Summer photo.png');
check('a unix path is dropped', lib.cleanFileName('../../etc/passwd.jpg', 'x') === 'passwd.jpg');
check('a windows path is dropped', lib.cleanFileName('C:\\Users\\me\\pic.png', 'x') === 'pic.png');
check('control characters and line breaks are removed', lib.cleanFileName('a\u0000b\nc.jpg', 'x') === 'abc.jpg');
check('runs of spaces collapse and the ends are trimmed', lib.cleanFileName('  a   b  .png ', 'x') === 'a b .png');
check('the fallback is used for empty and non-string names', lib.cleanFileName('', 'image.png') === 'image.png' && lib.cleanFileName(null, 'image.png') === 'image.png' && lib.cleanFileName('///', 'image.png') === 'image.png');
check('at most 120 characters', lib.cleanFileName('a'.repeat(300) + '.png', 'x').length === 120);
check('a long name is cut on characters, not in the middle of an emoji', (() => { const n = lib.cleanFileName('😀'.repeat(200), 'x'); return Array.from(n).length === 120 && !n.includes('\ufffd'); })());
check('markup is kept as plain text (it is escaped where shown)', lib.cleanFileName('<img src=x onerror=alert(1)>.png', 'x') === '<img src=x onerror=alert(1)>.png');

console.log('\nfiles still needed by unsent posts');
const K1 = '11111111-1111-4111-8111-111111111111.png', K2 = '22222222-2222-4222-8222-222222222222.mp4', K3 = '33333333-3333-4333-8333-333333333333.jpg';
const env = (rows) => ({ DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: rows.map((media_keys) => ({ media_keys })) }) }) }) } });
const keys = await lib.referencedKeys(env([
  JSON.stringify([`https://post.vaneapp.dev/api/media/${K1}`]),
  JSON.stringify([K2]),
  JSON.stringify([`https://post.vaneapp.dev/api/media/${K3}?v=2#x`]),
]), 'u');
check('our public link, a bare key and a link with a query are all recognised', keys.has(K1) && keys.has(K2) && keys.has(K3) && keys.size === 3, [...keys].join());
const none = await lib.referencedKeys(env([
  JSON.stringify(['https://example.com/photo.jpg']),
  'not json',
  JSON.stringify({ a: 1 }),
  JSON.stringify([42, null]),
  '[]',
]), 'u');
check('foreign links, broken JSON and odd shapes are ignored without errors', none.size === 0);

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) { console.log('Failed:\n  - ' + failed.join('\n  - ')); process.exit(1); }
