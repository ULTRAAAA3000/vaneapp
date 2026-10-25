#!/usr/bin/env node
/** Unit checks for the sign-up age gate (functions/api/lib/age.ts). No server needed:  npm run test:unit */
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'vane-unit-'));
const out = join(dir, 'age.mjs');
await build({ entryPoints: ['functions/api/lib/age.ts'], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent' });
const age = await import(pathToFileURL(out).href);
rmSync(dir, { recursive: true, force: true });

let passed = 0;
const failed = [];
const check = (name, cond) => { if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed.push(name); console.log(`  ✗ ${name}`); } };
const now = new Date(Date.UTC(2026, 9, 24, 12));   // 24 Oct 2026

console.log('\ndate of birth');
check('junk and impossible dates are refused', ['', 'x', '2000-13-01', '2001-02-30', '1800-01-01', '2999-01-01', 5, null, undefined].every((v) => age.parseBirth(v, now) === null));
check('a real date is read', JSON.stringify(age.parseBirth('2010-02-28', now)) === '{"y":2010,"m":2,"d":28}');
check('the day before the 16th birthday is 15', age.ageOf(age.parseBirth('2010-10-25', now), now) === 15);
check('on the 16th birthday it is 16', age.ageOf(age.parseBirth('2010-10-24', now), now) === 16);
check('a 12-year-old is under the limit', age.ageOf(age.parseBirth('2014-05-05', now), now) < age.MIN_AGE);
check('a 29 February birthday counts', age.ageOf(age.parseBirth('2008-02-29', now), now) === 18);

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
