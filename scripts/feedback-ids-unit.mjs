#!/usr/bin/env node
/**
 * Guards the Feedback board (public/assets/feedback.js) against the bug that made "Add to the board" do nothing: its title field had
 * id="fbName", the same id the Facebook panel of the dashboard already uses, so document.getElementById returned the Facebook field
 * and every idea looked untitled.  npm run test:unit
 */
import { readFileSync } from 'node:fs';

const js = readFileSync('public/assets/feedback.js', 'utf8');
const pages = ['public/app.html', 'public/studio.html', 'public/analytics.html'].filter((f) => { try { return readFileSync(f, 'utf8').includes('/assets/feedback.js'); } catch { return false; } });

let passed = 0;
const failed = [];
const check = (name, cond) => { if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed.push(name); console.log(`  ✗ ${name}`); } };

// ids the board writes into the page: id="x" / id=\"x\" in its markup strings, and ids it assigns in code (el.id = 'x')
const mine = new Set([...js.matchAll(/\bid=\\?"([A-Za-z][\w-]*)\\?"/g)].map((m) => m[1]).filter((id) => !id.endsWith('-')));
for (const m of js.matchAll(/\.id\s*=\s*'([A-Za-z][\w-]*)'/g)) mine.add(m[1]);

console.log('\nids of the feedback board');
check('the board makes its own elements (a sanity check on this test)', mine.size >= 10 && mine.has('feedbackName') && mine.has('feedbackSend'));
check('every id carries the "feedback" prefix, so it cannot collide with a panel of the dashboard', [...mine].every((id) => id.startsWith('feedback')));
for (const f of pages) {
  const html = readFileSync(f, 'utf8');
  const clash = [...mine].filter((id) => new RegExp(`\\bid="${id}"`).test(html));
  check(`${f} has no element with an id of the board (${clash.join(', ') || 'none'})`, clash.length === 0);
}
check('the board looks its elements up inside its own dialog, not on the whole page', /function \$\(id\)\s*\{\s*return dlg\.querySelector\(/.test(js) && !/document\.getElementById\(/.test(js));
check('the board is loaded by the dashboard', pages.includes('public/app.html'));

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
