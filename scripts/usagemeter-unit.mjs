#!/usr/bin/env node
/**
 * The "12.4 MB of 100 MB used · 9 files" line (public/assets/usage-meter.js) that the Library, the editor's upload box and the library
 * dialog share. The real file runs in an isolated context with a fake Vane.api.   npm run test:unit
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const code = readFileSync('public/assets/usage-meter.js', 'utf8');
function load({ host = 'vaneapp.dev', api = async () => ({ ok: false }) } = {}) {
  const ctx = { Vane: { api }, location: { hostname: host } };
  vm.runInNewContext(code, ctx);
  return ctx.Vane.libraryUsage;
}
let passed = 0;
const failed = [];
const check = (name, cond, extra = '') => { if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed.push(name); console.log(`  ✗ ${name} ${extra}`); } };
const MB = 1048576;
const u = (usedMb, limitMb, count, upgrade = false) => ({ usedBytes: Math.round(usedMb * MB), count, limitBytes: limitMb === null ? null : limitMb * MB, upgrade });
const { html } = load();

console.log('\nWith a maximum');
{
  const h = html(u(12.4, 100, 9));
  check('says "12.4 MB of 100 MB used" and "9 files"', h.includes('12.4 MB of 100 MB used') && h.includes('9 files'), h);
  check('the meter is as wide as the share used (12%) and white', h.includes('width:12%') && h.includes('background:#fff'), h);
  check('plenty of room: no warning', !/Running low|library is full/.test(h));
  check('"1 file" in the singular', html(u(1, 100, 1)).includes('1 file<') && !html(u(1, 100, 1)).includes('1 files'));
}
{
  const h = html(u(85, 100, 20));
  check('85%: "Running low on room", the bar is still white', /Running low on room/.test(h) && h.includes('width:85%') && h.includes('#fff'), h);
}
{
  const h = html(u(10, 10, 2, true));
  check('Free Trial full: "10 MB of 10 MB", full bar in red, the library is full', h.includes('10 MB of 10 MB used') && h.includes('width:100%') && h.includes('#f87171') && h.includes('The library is full.'), h);
  check('Free Trial full: points to the plans with more space', h.includes('see the plans with more space') && h.includes('href="/pricing"'), h);
}
{
  const h = html(u(100, 100, 20, false));
  check('a paid plan that is full: the same message, but no push to buy', h.includes('The library is full.') && !h.includes('plans with more space'), h);
  check('over the maximum never draws more than 100%', html(u(12, 10, 3)).includes('width:100%'));
  check('the plan link goes to the main site from the post and studio hosts', html(u(10, 10, 1, true)).includes('href="/pricing"') && load({ host: 'post.vaneapp.dev' }).html(u(10, 10, 1, true)).includes('href="https://vaneapp.dev/pricing"') && load({ host: 'studio.vaneapp.dev' }).html(u(10, 10, 1, true)).includes('href="https://vaneapp.dev/pricing"'));
}

console.log('\nWithout a maximum (limits not enforced)');
{
  const h = html(u(5, null, 3));
  check('only what is used: "5 MB used · 3 files", no maximum, no meter', h.includes('5 MB used · 3 files') && !h.includes(' of ') && !h.includes('meter'), h);
  check('an empty library says 0 KB', html(u(0, null, 0)).includes('0 KB used · 0 files'));
  check('missing numbers never show as NaN or undefined', !/NaN|undefined/.test(html({})), html({}));
}

console.log('\nFilling a box from GET /api/library/usage');
{
  const box = () => ({ innerHTML: '', hidden: true, classList: { add(c) { if (c === 'hidden') this.owner.hidden = true; }, remove(c) { if (c === 'hidden') this.owner.hidden = false; } } });
  const mk = () => { const b = box(); b.classList.owner = b; return b; };
  let asked = null;
  const ok = load({ api: async (m, path) => { asked = [m, path]; return { ok: true, data: { ok: true, usage: u(3, 10, 2, true) } }; } });
  const b1 = mk(); await ok.show(b1);
  check('asks GET /api/library/usage', asked && asked[0] === 'GET' && asked[1] === '/api/library/usage', JSON.stringify(asked));
  check('fills the box and shows it', b1.innerHTML.includes('3 MB of 10 MB used') && b1.hidden === false, b1.innerHTML);
  const b2 = mk(); b2.hidden = false; await load({ api: async () => ({ ok: false, status: 503 }) }).show(b2);
  check('a failed answer (not set up, signed out) hides the box instead of showing a wrong number', b2.hidden === true && b2.innerHTML === '');
  const b3 = mk(); b3.hidden = false; await load({ api: async () => ({ ok: true, data: { ok: true } }) }).show(b3);
  check('an answer without numbers hides it too', b3.hidden === true);
}

console.log('\nThe red warning at the top of the dashboard');
{
  const lib = load();
  const box = () => ({ innerHTML: '', cls: new Set(['hidden']), classList: { add(c) { this.o.cls.add(c); }, remove(c) { this.o.cls.delete(c); } }, get hidden() { return this.cls.has('hidden'); } });
  const mk = () => { const b = box(); b.classList.o = b; return b; };
  const b1 = mk();
  lib.warn(b1, { ...u(112, 100, 5), over: { since: 1000, deadline: Date.UTC(2026, 10, 12) / 1000 } });
  check('over the plan: shown, with the sizes and the day', !b1.hidden && b1.innerHTML.includes('112 MB of 100 MB') && b1.innerHTML.includes('12 Nov 2026'), b1.innerHTML);
  check('it links to the Library', b1.innerHTML.includes('href="#library"') && b1.innerHTML.includes('Open the Library'));
  check('it says the latest uploads will be removed', b1.innerHTML.includes('latest uploads will be removed'));
  const b2 = mk(); b2.cls.delete('hidden');
  lib.warn(b2, { ...u(50, 100, 5), over: null });
  check('under the plan: hidden and empty', b2.hidden && b2.innerHTML === '');
  const b3 = mk();
  lib.warn(b3, null);
  check('no numbers: nothing shown', b3.hidden);
}

console.log('\nA plan of 0 MB, and a warning that is out of date');
{
  const lib = load();
  const box = () => ({ innerHTML: '', cls: new Set(['hidden']), classList: { add(c) { this.o.cls.add(c); }, remove(c) { this.o.cls.delete(c); } }, get hidden() { return this.cls.has('hidden'); } });
  const mk = () => { const b = box(); b.classList.o = b; return b; };
  const full = lib.html(u(3, 0, 1, true)), empty = lib.html(u(0, 0, 0, true));
  check('0 MB is a limit, not "no limit": "3 MB of 0 KB used", the meter is full', full.includes('3 MB of 0 KB used') && full.includes('width:100%') && !full.includes(' used · '), full);
  check('an empty library on a 0 MB plan: 0% and no NaN', empty.includes('0 KB of 0 KB used') && empty.includes('width:0%') && !/NaN|Infinity/.test(empty), empty);
  check('the short counter next to the Upload button says 3 / 0 KB', lib.short(u(3, 0, 1)) === '3 / 0 KB', lib.short(u(3, 0, 1)));
  const b1 = mk();
  lib.warn(b1, { ...u(3, 0, 1), over: { since: 1000, deadline: Date.UTC(2026, 10, 12) / 1000 } });
  check('over a 0 MB plan: the red warning is shown (the files would go after 3 days, so it must be)', !b1.hidden && b1.innerHTML.includes('3 MB of 0 KB'), b1.innerHTML);
  const b2 = mk(); b2.cls.delete('hidden');
  lib.warn(b2, { ...u(9, 10, 3), over: { since: 1000, deadline: 2000000000 } });
  check('a warning that is out of date (cleaned up below the limit, not reloaded yet) hides itself', b2.hidden && b2.innerHTML === '');
  const b3 = mk();
  lib.warn(b3, { ...u(5, null, 3), over: { since: 1000, deadline: 2000000000 } });
  check('no limit at all: never a warning', b3.hidden);
}

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
