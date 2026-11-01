#!/usr/bin/env node
/**
 * Unit checks for the Feedback board rules: what counts as a valid idea, how text is cleaned, how duplicates are spotted.
 * No server needed:  npm run test:unit
 */
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'vane-unit-'));
const out = join(dir, 'feedback.mjs');
await build({ entryPoints: ['functions/api/lib/feedback.ts'], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent' });
const fb = await import(pathToFileURL(out).href);
rmSync(dir, { recursive: true, force: true });

let passed = 0;
const failed = [];
const check = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed.push(name); console.log(`  ✗ ${name} ${extra}`); }
};

console.log('\nan idea');
const ok = fb.validateSuggestion({ kind: 'network', title: '  Pinterest  ', body: 'Pins\n\n\n\nplease' });
check('a good idea is accepted and trimmed', ok.ok && ok.title === 'Pinterest' && ok.kind === 'network');
check('line breaks in the details are kept, long runs of them are cut down', ok.ok && ok.body === 'Pins\n\nplease', JSON.stringify(ok.body));
check('an unknown kind becomes a feature', fb.validateSuggestion({ kind: 'hack', title: 'Dark mode' }).kind === 'feature');
check('a missing kind becomes a feature', fb.validateSuggestion({ title: 'Dark mode' }).kind === 'feature');
check('a title that is too short is refused', !fb.validateSuggestion({ title: 'ab' }).ok);
check('a missing title is refused', !fb.validateSuggestion({}).ok && !fb.validateSuggestion({ title: 42 }).ok);
check('a title of exactly the limit is accepted', fb.validateSuggestion({ title: 'a'.repeat(fb.TITLE_MAX) }).ok);
check('a title over the limit is refused', !fb.validateSuggestion({ title: 'a'.repeat(fb.TITLE_MAX + 1) }).ok);
check('details of exactly the limit are accepted', fb.validateSuggestion({ title: 'Dark mode', body: 'b'.repeat(fb.BODY_MAX) }).ok);
check('details over the limit are refused', !fb.validateSuggestion({ title: 'Dark mode', body: 'b'.repeat(fb.BODY_MAX + 1) }).ok);
check('very long details are refused without being processed', !fb.validateSuggestion({ title: 'Dark mode', body: 'b'.repeat(100000) }).ok);
check('links are refused in the title', !fb.validateSuggestion({ title: 'See https://spam.example' }).ok);
check('links are refused in the details', !fb.validateSuggestion({ title: 'Dark mode', body: 'go to HTTP://spam.example' }).ok);
check('control characters in the title are replaced', fb.validateSuggestion({ title: 'Dark\u0000\u0007 mode' }).title === 'Dark mode');
check('a title cannot contain a line break', fb.validateSuggestion({ title: 'Dark\nmode' }).title === 'Dark mode');

console.log('\nduplicates');
const k = fb.titleKey;
check('case and punctuation do not matter', k('Pinterest!') === k('  pinterest '));
check('spaces and dashes do not matter', k('Dark-mode') === k('dark mode'));
check('different ideas have different keys', k('Pinterest') !== k('Tumblr'));
check('letters of other alphabets count', k('Піnterest') !== '' && k('Підтримка Pinterest') !== k('Pinterest'));
check('a title with no letters or digits has an empty key', k('!!!') === '');

console.log('\nlists');
check('every status the admin can pick is known', ['open', 'planned', 'building', 'done', 'declined'].every((s) => fb.FEEDBACK_STATUSES.includes(s)));
check('every kind the widget offers is known', ['network', 'feature', 'bug', 'other'].every((s) => fb.FEEDBACK_KINDS.includes(s)));
check('the daily limit is below the limit on the board', fb.IDEAS_PER_DAY < fb.IDEAS_ON_BOARD);

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
