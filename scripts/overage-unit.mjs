#!/usr/bin/env node
/**
 * Unit checks for the extra-usage ("over the quota") money rules: what prices and quotas the admin catalog may set
 * (functions/api/lib/plans.ts), how a period key becomes a time range (lib/usage.ts) and how the admin report adds
 * extra posts and extra AI credits together (lib/extrausage.ts). No server needed:  npm run test:unit
 */
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'vane-unit-'));
const load = async (entry, name) => {
  const out = join(dir, name + '.mjs');
  await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent' });
  return import(pathToFileURL(out).href);
};
const plans = await load('functions/api/lib/plans.ts', 'plans');
const usage = await load('functions/api/lib/usage.ts', 'usage');
const extra = await load('functions/api/lib/extrausage.ts', 'extra');
rmSync(dir, { recursive: true, force: true });

let passed = 0, failed = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) passed++; else failed++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok ? '' : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
};
const USD = 1_000_000;

console.log('price (what an admin may set per extra use)');
eq('0.02 is a price', plans.price(0.02), 0.02);
eq('100 is the most', plans.price(100), 100);
eq('over 100 is refused', plans.price(100.01), null);
eq('0 means no price', plans.price(0), null);
eq('a negative price would pay users to go over: refused', plans.price(-0.05), null);
eq('text is refused', plans.price('0.02'), null);
eq('NaN is refused', plans.price(NaN), null);
eq('Infinity is refused', plans.price(Infinity), null);
eq('missing is no price', plans.price(undefined), null);

console.log('specFromCatalog');
let s = plans.specFromCatalog('x', 'X', { postsPerMonth: 1000, overagePostUsd: 0.015, overageAiPostUsd: 0.045, aiCredits: 250 });
eq('extra post price in micro-USD', s.overage, { post: 15000, aiPost: 45000 });
s = plans.specFromCatalog('x', 'X', { postsPerMonth: 1000, overagePostUsd: -1, overageAiPostUsd: -1 });
eq('negative prices: the plan simply stops', s.overage, null);
s = plans.specFromCatalog('x', 'X', { postsPerMonth: 1000, overagePostUsd: 0, overageAiPostUsd: 0 });
eq('zero prices: the plan simply stops (not free extras)', s.overage, null);
s = plans.specFromCatalog('x', 'X', { postsPerMonth: 1000, overagePostUsd: 0.03 });
eq('only a post price: AI extras use it too', s.overage, { post: 30000, aiPost: 30000 });
s = plans.specFromCatalog('x', 'X', { postsPerMonth: 1000, overageAiPostUsd: 0.09 });
eq('only an AI price: posts use it too', s.overage, { post: 90000, aiPost: 90000 });
s = plans.specFromCatalog('x', 'X', { postsPerMonth: -5, apiPostsPerMonth: -1, aiCredits: -10, channels: -2 });
eq('a negative quota means none, never unlimited', [s.ui, s.api, s.aiCredits, s.channels], [0, 0, 0, 0]);
s = plans.specFromCatalog('x', 'X', { postsPerMonth: 10.9, aiCredits: 7.5 });
eq('quotas are whole numbers', [s.ui, s.aiCredits], [10, 7]);
s = plans.specFromCatalog('x', 'X', { postsPerMonth: 10 });
eq('a missing AI quota is still "unlimited" (null)', s.aiCredits, null);

console.log('periodRange');
const now = Math.floor(Date.UTC(2026, 9, 28) / 1000);
eq('a month', usage.periodRange('2026-10', now), { from: Math.floor(Date.UTC(2026, 9, 1) / 1000), to: Math.floor(Date.UTC(2026, 10, 1) / 1000) });
eq('December rolls into the next year', usage.periodRange('2026-12', now).to, Math.floor(Date.UTC(2027, 0, 1) / 1000));
eq('lifetime is everything up to now', usage.periodRange('lifetime', now), { from: 0, to: now + 1 });

console.log('combineExtraUsage');
const m = 1_000;
let c = extra.combineExtraUsage(
  [{ user_id: 'a', email: 'a@x', overage_posts: 4, overage_micro_usd: 4 * 15 * m + 3 * 20 * m }],
  [{ user_id: 'a', email: 'a@x', n: 3, micro: 3 * 20 * m }],
);
eq('the counter holds posts and AI: the AI share is taken out', [c.rows[0].posts, c.rows[0].postsMicro, c.rows[0].aiUses, c.rows[0].aiMicro], [4, 60 * m, 3, 60 * m]);
eq('to bill = posts + AI', [c.rows[0].totalMicro, c.totalMicro], [120 * m, 120 * m]);
c = extra.combineExtraUsage([], [{ user_id: 'b', email: 'b@x', n: 2, micro: 40 * m }]);
eq('an account with only AI extras still shows', [c.rows.length, c.rows[0].totalMicro], [1, 40 * m]);
c = extra.combineExtraUsage([{ user_id: 'a', email: 'a@x', overage_posts: 0, overage_micro_usd: 0 }], []);
eq('nothing owed: no row', c.rows, []);
c = extra.combineExtraUsage([{ user_id: 'a', email: 'a@x', overage_posts: 1, overage_micro_usd: 10 * m }], [{ user_id: 'a', email: 'a@x', n: 5, micro: 99 * m }]);
eq('a log larger than the counter never makes posts negative', c.rows[0].postsMicro, 0);
c = extra.combineExtraUsage(
  [{ user_id: 'a', email: 'a@x', overage_posts: 1, overage_micro_usd: 10 * m }, { user_id: 'b', email: 'b@x', overage_posts: 9, overage_micro_usd: 90 * m }], []);
eq('the biggest bill comes first', c.rows.map((r) => r.userId), ['b', 'a']);
eq('the prices are real money in micro-USD', USD, 1_000_000);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
