#!/usr/bin/env node
// The landing page's "How much would it cost me?" estimate (public/assets/estimate.js): the plan it picks, the price it shows,
// and that its fallback prices are the ones the database is seeded with.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync('public/assets/estimate.js', 'utf8');
const ctx = { module: { exports: {} }, Intl, Math, Number, Object, Array, String };
vm.runInNewContext(src, ctx);
const { pick, fmt, STEPS, FALLBACK } = ctx.module.exports;

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) passed++; else failed++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok ? '' : `\n      ${detail}`}`);
};
const plan = (id, priceCents, limits, extra = {}) => ({ id, kind: 'plan', name: id, badge: '', priceCents, comparePriceCents: null, currency: 'USD', ctaLabel: 'Get started', comingSoon: false, buyable: true, limits, ...extra });
const LIVE = [
  plan('free', 0, { channels: 2, postsLifetime: 30, apiAccess: 1 }),
  plan('api', 799, { apiPostsPerMonth: 180, apiAccess: 1, overagePostUsd: 0.03 }),
  plan('pro', 1199, { postsPerMonth: 1000, overagePostUsd: 0.015 }),
];
const id = (r) => r && r.plan.id;

console.log('\nWhich plan');
check('a handful of posts on two channels fits the free trial', id(pick(LIVE, 20, 2, 'dashboard')) === 'free');
check('three channels do not fit the trial (it allows two)', id(pick(LIVE, 20, 3, 'dashboard')) === 'pro');
check('31 posts do not fit the trial (30 in total)', id(pick(LIVE, 31, 1, 'dashboard')) === 'pro');
check('the dashboard counts the Pro quota: 300 posts = the plain price', JSON.stringify(pick(LIVE, 300, 5, 'dashboard')).includes('"totalCents":1199') && pick(LIVE, 300, 5, 'dashboard').extraPosts === 0);
{
  const r = pick(LIVE, 1500, 5, 'dashboard');
  check('1,500 posts on Pro: 500 extra at $0.015 = $7.50, total $19.49', id(r) === 'pro' && r.extraPosts === 500 && r.extraCents === 750 && r.totalCents === 1949, JSON.stringify(r));
}
check('API mode with 100 posts picks the Developer API', id(pick(LIVE, 100, 5, 'api')) === 'api');
{
  const r = pick(LIVE, 300, 5, 'api');
  check('API mode with 300 posts: 120 extra at $0.03, total $11.59', id(r) === 'api' && r.totalCents === 1159, JSON.stringify(r));
}
check('API mode: a trial-sized volume still fits the free trial (it has API access)', id(pick(LIVE, 10, 2, 'api')) === 'free');
check('API mode ignores Pro (its quota is dashboard posts)', id(pick([LIVE[2]], 100, 1, 'api')) === null);
check('the number of channels never changes the price on a paid plan', pick(LIVE, 300, 3, 'dashboard').totalCents === pick(LIVE, 300, 20, 'dashboard').totalCents);

console.log('\nThe price list is the source');
check('a changed live price is what the estimate shows', pick(LIVE.map((p) => (p.id === 'pro' ? { ...p, priceCents: 999 } : p)), 300, 5, 'dashboard').totalCents === 999);
check('a plan marked coming soon is never picked', id(pick([plan('suite', 100, { postsPerMonth: 1000 }, { comingSoon: true }), LIVE[2]], 300, 5, 'dashboard')) === 'pro');
check('an add-on is never picked as the plan', id(pick([plan('addon', 100, { postsPerMonth: 1000 }, { kind: 'addon' }), LIVE[2]], 300, 5, 'dashboard')) === 'pro');
check('posts above the quota need an overage rate: without one that plan is skipped', pick([plan('flat', 500, { postsPerMonth: 100 })], 300, 1, 'dashboard') === null);
check('an empty or missing price list gives no plan, not an error', pick([], 100, 1, 'dashboard') === null && pick(undefined, 100, 1, 'dashboard') === null);
check('the cheapest of two fitting plans wins', id(pick([plan('a', 2000, { postsPerMonth: 1000 }), plan('b', 1500, { postsPerMonth: 1000 })], 300, 1, 'dashboard')) === 'b');
check('prices are formatted like the pricing cards ($11.99, $0, $7.50)', fmt(1199, 'USD') === '$11.99' && fmt(0, 'USD') === '$0' && fmt(750, 'USD') === '$7.50');

console.log('\nThe fallback matches the database seed');
const schema = readFileSync('schema.sql', 'utf8');
for (const [pid, cents] of [['api', 799], ['pro', 1199]]) {
  const fb = FALLBACK.find((p) => p.id === pid);
  check(`${pid}: the fallback price is the seeded price (${cents})`, fb && fb.priceCents === cents && new RegExp(`\\('${pid}',[^)]*?,\\s*${cents},`).test(schema), JSON.stringify(fb && fb.priceCents));
}
check('the fallback quotas are the seeded ones (30 trial, 180 API, 1,000 Pro)', FALLBACK.find((p) => p.id === 'free').limits.postsLifetime === 30 && FALLBACK.find((p) => p.id === 'api').limits.apiPostsPerMonth === 180 && FALLBACK.find((p) => p.id === 'pro').limits.postsPerMonth === 1000);

console.log('\nOn the landing page');
const home = readFileSync('public/index.html', 'utf8');
check('the estimate card, both sliders and the mode switch are there', ['id="estimate"', 'id="estPosts"', 'id="estCh"', 'id="estResult"', 'data-est-mode="dashboard"', 'data-est-mode="api"'].every((t) => home.includes(t)));
check('the posts slider covers every step and starts on 300', home.includes(`max="${STEPS.length - 1}"`) && STEPS[Number(home.match(/id="estPosts"[^>]*value="(\d+)"/)[1])] === 300);
check('the page loads the script', /\/assets\/estimate\.js\?v=[\w.-]+/.test(home));
check('both sliders have a label', home.includes('for="estPosts"') && home.includes('for="estCh"'));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
