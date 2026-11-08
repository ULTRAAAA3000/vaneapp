#!/usr/bin/env node
/**
 * The quota gates and the prepaid balance together, on a REAL D1 (Miniflare, in memory) with the real tables from schema.sql:
 * the dashboard's hard stop, extra posts and extra AI credits paid from the balance, refunds, and parallel requests that must never
 * spend the same money or the same last unit. No server needed:  npm run test:unit
 */
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'vane-quota-'));
const load = async (entry, name) => {
  const out = join(dir, name + '.mjs');
  await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent' });
  return import(pathToFileURL(out).href);
};
const U = await load('functions/api/lib/usage.ts', 'usage');
const B = await load('functions/api/lib/balance.ts', 'balance');
const V = await load('functions/api/lib/videoai.ts', 'videoai');

const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok"); } }', d1Databases: { DB: 'quota-test' }, compatibilityDate: '2025-01-01' });
const db = await mf.getD1Database('DB');
const env = { DB: db };

// the real tables, taken out of schema.sql by name
const schema = readFileSync('schema.sql', 'utf8');
const table = (name) => {
  const m = new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\);`).exec(schema);
  if (!m) throw new Error('table not found in schema.sql: ' + name);
  return m[0].replace(/--.*$/gm, '').replace(/;\s*$/, '');
};
await db.prepare('CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT)').run();
for (const t of ['usage_counters', 'usage_logs', 'user_ai_bonus', 'ai_pass', 'ai_pass_usage', 'user_balance', 'balance_ledger', 'video_ai_usage', 'video_ai_overage', 'video_ai_settings', 'video_subscriptions']) await db.prepare(table(t)).run();
const ids = ['pro', 'free', 'api', 'aiu', 'race', 'vid'];
for (const id of ids) await db.prepare('INSERT INTO users (id, email) VALUES (?1, ?2)').bind(id, id + '@x').run();

const now = Math.floor(Date.UTC(2026, 10, 15) / 1000);
const period = '2026-11';
const sub = (plan, overage = false) => ({ plan, apiAddon: false, overageEnabled: overage, overageCapMicro: 20_000_000, status: 'active', currentPeriodEnd: null, lapsed: false });
const setCounters = (id, cols, per = period) => db.prepare(`INSERT INTO usage_counters (user_id, period, ${Object.keys(cols).join(', ')}) VALUES (?1, ?2, ${Object.keys(cols).map((_, i) => '?' + (i + 3)).join(', ')})
  ON CONFLICT(user_id, period) DO UPDATE SET ${Object.keys(cols).map((k, i) => `${k} = ?${i + 3}`).join(', ')}`).bind(id, per, ...Object.values(cols)).run();
const counters = async (id) => db.prepare('SELECT * FROM usage_counters WHERE user_id = ?1 AND period = ?2').bind(id, period).first();
const bal = (id) => B.getBalanceMicro(env, id);
const top = (id, micro) => db.prepare('INSERT INTO user_balance (user_id, micro_usd) VALUES (?1, ?2) ON CONFLICT(user_id) DO UPDATE SET micro_usd = ?2').bind(id, micro).run();

let passed = 0, failed = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) passed++; else failed++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok ? '' : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
};

try {
  console.log('Pro: dashboard posts (1000 a month, extra $0.015)');
  await setCounters('pro', { ui_posts: 999 });
  let r = await U.reserveUiPost(env, 'pro', sub('pro'), now, 1);
  eq('the 1000th post is free', [r.ok, r.overage], [true, false]);
  r = await U.reserveUiPost(env, 'pro', sub('pro'), now, 1);
  eq('the 1001st is a hard stop when paying for extra is off', [r.ok, r.code, r.reason], [false, 'quota_exceeded', 'off']);
  r = await U.reserveUiPost(env, 'pro', sub('pro', true), now, 1);
  eq('switched on but the balance is empty: a hard stop, reason "balance"', [r.ok, r.code, r.reason], [false, 'quota_exceeded', 'balance']);
  eq('nothing was counted by the refusals', (await counters('pro')).ui_posts, 1000);
  await top('pro', 100_000);
  r = await U.reserveUiPost(env, 'pro', sub('pro', true), now, 1);
  eq('with $0.10 on the balance the extra post goes through', [r.ok, r.overage, r.costMicro], [true, true, 15_000]);
  eq('the price came out of the balance', await bal('pro'), 85_000);
  const c = await counters('pro');
  eq('and was counted as extra', [c.ui_posts, c.overage_posts, c.overage_micro_usd], [1001, 1, 15_000]);
  await U.releaseApiPost(env, 'pro', r, 1);
  eq('releasing it gives the money back', await bal('pro'), 100_000);
  const c2 = await counters('pro');
  eq('and takes it off the counters', [c2.ui_posts, c2.overage_posts, c2.overage_micro_usd], [1000, 0, 0]);

  console.log('the summary the dashboard banner reads');
  let s = await U.usageSummary(env, 'pro', sub('pro', true), now);
  eq('quota full but the balance covers an extra post: not stopped', s.limit.reached, false);
  await top('pro', 10_000);
  s = await U.usageSummary(env, 'pro', sub('pro', true), now);
  eq('quota full and the balance cannot cover one: stopped', [s.limit.reached, s.limit.postsLeft], [true, 0]);
  eq('it carries the price, the reset date and the balance', [s.limit.extraPostUsd, s.limit.resetsAt > now, s.balanceUsd], [0.015, true, 0.01]);

  console.log('Free Trial: 30 posts in total, never charged');
  await setCounters('free', { ui_posts: 20, api_posts: 9 }, 'lifetime'); // the Free Trial's allowance is one-time: period "lifetime"
  r = await U.reserveUiPost(env, 'free', sub('free'), now, 1);
  eq('the 30th post (dashboard and API share one total) is free', r.ok, true);
  r = await U.reserveUiPost(env, 'free', sub('free', true), now, 1);
  eq('the 31st is a hard stop even with the switch on (no price on this plan)', [r.ok, r.reason], [false, 'off']);
  eq('the message sends them to a plan, and says it does not reset', U.stopMessage({ label: 'Free Trial', unit: 'posts', one: 'post', reason: 'off', resetsAt: null, priceUsd: null }), 'You have reached your Free Trial quota of posts. It does not reset. Choose a plan to continue.');

  console.log('Developer API: dashboard posts come out of the API allowance');
  await setCounters('api', { api_posts: 179 });
  r = await U.reserveUiPost(env, 'api', sub('api'), now, 1);
  eq('the last of the 180 can be used from the dashboard', [r.ok, r.column], [true, 'api_posts']);
  r = await U.reserveUiPost(env, 'api', sub('api'), now, 1);
  eq('then the dashboard stops too', [r.ok, r.reason], [false, 'off']);
  r = await U.reserveApiPost(env, 'api', sub('api'), now, 1);
  eq('and so does the API', [r.ok, r.reason], [false, 'off']);

  console.log('parallel requests never spend the same money or the same last unit');
  await setCounters('race', { ui_posts: 999 });
  await top('race', 5 * 15_000); // five extra posts
  const burst = await Promise.all(Array.from({ length: 40 }, () => U.reserveUiPost(env, 'race', sub('pro', true), now, 1)));
  eq('40 parallel posts: 1 free + 5 paid go through', burst.filter((x) => x.ok).length, 6);
  eq('exactly 5 were paid', burst.filter((x) => x.ok && x.overage).length, 5);
  eq('the balance is exactly spent, not below', await bal('race'), 0);
  eq('and the counter says 1005', (await counters('race')).ui_posts, 1005);

  console.log('extra AI credits (Pro: 250 a month, extra $0.045)');
  await setCounters('aiu', { ai_generations: 250 });
  let a = await U.reserveAiGeneration(env, 'aiu', sub('pro'), now);
  eq('credits used, switch off: refused, reason "off"', [a.ok, a.code, a.reason], [false, 'ai_quota_exceeded', 'off']);
  a = await U.reserveAiGeneration(env, 'aiu', sub('pro', true), now);
  eq('switch on, no balance: refused, reason "balance"', [a.ok, a.reason], [false, 'balance']);
  await top('aiu', 100_000);
  a = await U.reserveAiGeneration(env, 'aiu', sub('pro', true), now);
  eq('with a balance the extra credit is paid from it', [a.ok, a.source, a.costMicro], [true, 'extra', 45_000]);
  eq('the balance is $0.055 now', await bal('aiu'), 55_000);
  await U.releaseAiGeneration(env, 'aiu', a);
  eq('a failed generation gives the money back', await bal('aiu'), 100_000);
  eq('and the credit', (await counters('aiu')).ai_generations, 250);
  const ledger = await db.prepare(`SELECT kind, delta_micro, what FROM balance_ledger WHERE user_id = 'aiu' ORDER BY id`).all();
  eq('the ledger shows the spend and the refund', ledger.results.map((x) => [x.kind, x.delta_micro, x.what]), [['charge', -45_000, 'ai'], ['refund', 45_000, 'ai']]);

  console.log('Vane Studio AI (50 included, extra $0.02, its own switch, the same balance)');
  await db.prepare(`INSERT INTO video_ai_usage (user_id, period, used) VALUES ('vid', '${period}', 50)`).run();
  let v = await V.reserveVideoAi(env, 'vid', now);
  eq('all included generations used, switch off: refused, reason "off"', v, { stop: 'off' });
  await db.prepare(`INSERT INTO video_ai_settings (user_id, overage_enabled) VALUES ('vid', 1)`).run();
  v = await V.reserveVideoAi(env, 'vid', now);
  eq('switch on, no balance: refused, reason "balance"', v, { stop: 'balance' });
  await top('vid', 1_000_000);
  v = await V.reserveVideoAi(env, 'vid', now);
  eq('with a balance the extra generation is paid from it ($0.02)', [v.kind, v.costMicro], ['overage', 20_000]);
  eq('the balance is $0.98', await bal('vid'), 980_000);
  await V.releaseVideoAi(env, 'vid', v);
  eq('a failed generation gives the money back', await bal('vid'), 1_000_000);
  const vo = await db.prepare(`SELECT uses, micro_usd FROM video_ai_overage WHERE user_id = 'vid'`).first();
  eq('and takes it off the extra-usage counter', [vo.uses, vo.micro_usd], [0, 0]);
  await top('vid', 5 * 20_000);
  const vburst = await Promise.all(Array.from({ length: 30 }, () => V.reserveVideoAi(env, 'vid', now)));
  eq('30 parallel generations with money for 5: exactly 5 go through', vburst.filter((x) => x.kind === 'overage').length, 5);
  eq('and the balance is exactly spent', await bal('vid'), 0);

  console.log('stop messages');
  eq('over the quota, switch off', U.stopMessage({ label: 'Pro Dashboard', unit: 'posts', one: 'post', reason: 'off', resetsAt: now, priceUsd: 0.015 }),
    'You have reached your Pro Dashboard quota of posts. It resets on 15 Nov 2026. To continue now, add funds to your balance and switch on paying for extra use ($0.015 each).');
  eq('switch on, balance too low', U.stopMessage({ label: 'Pro Dashboard', unit: 'posts', one: 'post', reason: 'balance', resetsAt: now, priceUsd: 0.015 }),
    'Your balance is too low for another extra post ($0.015 each). Add funds to continue. Or wait: your quota resets on 15 Nov 2026.');
} finally {
  await mf.dispose();
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
