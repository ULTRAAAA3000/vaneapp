#!/usr/bin/env node
// The yellow "go Pro" banner at the top of the dashboard (public/app.html #proPromo, shown by renderLimit in assets/dashboard.js):
// only on the Free Trial, never together with the hard-stop banner, and it leads to the pricing page.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => { if (ok) passed++; else failed++; console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok ? '' : `\n      ${detail}`}`); };

const html = readFileSync('public/app.html', 'utf8');
const js = readFileSync('public/assets/dashboard.js', 'utf8');

console.log('\nMarkup');
const tag = html.match(/<a id="proPromo"[^>]*>/)?.[0] || '';
check('the banner exists and is hidden until the script decides', /\shidden\s/.test(tag), tag);
check('it is yellow', /from-yellow-300/.test(tag) && /to-amber-300/.test(tag));
check('it is one link, and the fallback target is the pricing page', /href="\/pricing"/.test(tag));
check('it comes after the hard-stop banner and before the storage warning (top of every tab)', html.indexOf('id="quotaStop"') < html.indexOf('id="proPromo"') && html.indexOf('id="proPromo"') < html.indexOf('id="storageWarn"'));
check('it sits above the tabs, so it shows on every tab', html.indexOf('id="proPromo"') < html.indexOf('id="dashTabs"'));

console.log('\nWhen it shows (renderLimit)');
const a = js.indexOf('function renderLimit() {'), b = js.indexOf('// Silent refresh', a);
const fnSrc = js.slice(a, b);
function run(usage, host = 'vaneapp.dev') {
  const els = {};
  const el = (id) => (els[id] ||= { id, hidden: true, style: {}, attrs: {}, textContent: '', setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; } });
  ['balancePill', 'quotaStop', 'balanceVal', 'proPromo', 'proPromoPlan', 'quotaStopText', 'quotaStopCta'].forEach(el);
  const ctx = {
    S: { usage }, $: el, balUsd: (n) => '$' + n, TOPUP: '/topup', fmtResetDay: { format: () => 'x' },
    Vane: { siteHome: () => (host === 'post.vaneapp.dev' ? 'https://vaneapp.dev/' : '/') }, Date, location: { hostname: host },
  };
  vm.runInNewContext(`${fnSrc}\nrenderLimit();`, ctx);
  return els;
}
const free = { plan: { id: 'free', label: 'Free Trial' }, balanceUsd: 0, limit: { reached: false } };
let e = run(free);
check('a Free Trial user sees it', e.proPromo.hidden === false && e.proPromo.style.display === 'flex');
check('it names the plan and links to the pricing page', e.proPromoPlan.textContent === 'Free Trial' && e.proPromo.attrs.href === '/pricing', JSON.stringify(e.proPromo.attrs));
check('on post. / studio. it links to the main site pricing page', run(free, 'post.vaneapp.dev').proPromo.attrs.href === 'https://vaneapp.dev/pricing');
e = run({ ...free, plan: { id: 'pro', label: 'Pro Dashboard' } });
check('a Pro user does not see it', e.proPromo.hidden === true && e.proPromo.style.display === '');
e = run({ ...free, plan: { id: 'api', label: 'Developer API' } });
check('a Developer API user does not see it', e.proPromo.hidden === true);
e = run({ ...free, limit: { reached: true, offersExtra: false, resetsAt: null } });
check('while the quota stop is shown, the promo stays away (the stop already says "Choose a plan")', e.proPromo.hidden === true && e.quotaStop.hidden === false);
e = run({ ...free, limit: undefined });
check('a usage answer without limit info still shows it for the Free Trial', e.proPromo.hidden === false);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
