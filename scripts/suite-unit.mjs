#!/usr/bin/env node
/** Unit checks for what buying the Vane Suite switches on (lib/billing.ts → activate, plan limits from schema.sql). In-memory SQLite, no network:  npm run test:unit */
import { build } from 'esbuild';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'vane-unit-'));
const load = async (entry, name) => {
  const out = join(dir, `${name}.mjs`);
  await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent' });
  return import(pathToFileURL(out).href);
};
const billing = await load('functions/api/lib/billing.ts', 'billing');
const plans = await load('functions/api/lib/plans.ts', 'plans');
rmSync(dir, { recursive: true, force: true });

/** A D1 look-alike over node:sqlite (the SQL is the same SQLite). */
function d1() {
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: false });
  db.exec(readFileSync('schema.sql', 'utf8'));
  db.exec(`INSERT INTO users (id, email) VALUES ('u1', 'buyer@example.com')`);
  const DB = { prepare(sql) {
    let args = [];
    const st = {
      bind(...a) { args = a; return st; },
      async first() { return db.prepare(sql).get(...args) ?? null; },
      async run() { const r = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes) } }; },
      async all() { return { results: db.prepare(sql).all(...args) }; },
    };
    return st;
  } };
  return { db, env: { DB } };
}

let passed = 0;
const failed = [];
const check = (name, cond) => { if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed.push(name); console.log(`  ✗ ${name}`); } };

const NOW = 1_800_000_000;
const order = (planId, interval = 'month') => ({ id: `ord-${planId}-${interval}`, user_id: 'u1', plan_id: planId, plan_name: planId, interval, amount_cents: 4000, currency: 'USD', provider: 'monobank', provider_ref: null, pay_url: null, pay_micro: null, tx_ref: null, status: 'paid', billing: '{}', note: null, created_at: NOW, expires_at: NOW + 3600, paid_at: NOW });
const sub = (db, table) => db.prepare(`SELECT status, current_period_end AS end FROM ${table} WHERE user_id = 'u1'`).get() ?? null;

console.log('\nbuying the Suite');
{
  const { db, env } = d1();
  await billing.activate(env, order('suite'), NOW);
  const end = billing.addInterval(NOW, 'month');
  const post = db.prepare(`SELECT plan, status, current_period_end AS end FROM subscriptions WHERE user_id = 'u1'`).get();
  check('Post Pro: plan "suite" is active', post?.plan === 'suite' && post.status === 'active' && post.end === end);
  check('Vane Studio is switched on for the same period', sub(db, 'video_subscriptions')?.status === 'active' && sub(db, 'video_subscriptions').end === end);
  check('Analytics Pro is switched on for the same period', sub(db, 'analytics_subscriptions')?.status === 'active' && sub(db, 'analytics_subscriptions').end === end);
  check('the AI Pass is switched on for the same period', sub(db, 'ai_pass')?.status === 'active' && sub(db, 'ai_pass').end === end);

  await billing.activate(env, order('suite'), NOW + 86400);
  const end2 = billing.addInterval(end, 'month');
  check('a renewal while it runs extends all four by one more period', [sub(db, 'video_subscriptions'), sub(db, 'analytics_subscriptions'), sub(db, 'ai_pass')].every((s) => s.end === end2) && db.prepare(`SELECT current_period_end AS e FROM subscriptions WHERE user_id = 'u1'`).get().e === end2);

  const yearly = d1();
  await billing.activate(yearly.env, order('suite', 'year'), NOW);
  const yend = billing.addInterval(NOW, 'year');
  check('a yearly purchase gives all four a year', ['video_subscriptions', 'analytics_subscriptions', 'ai_pass'].every((t) => sub(yearly.db, t).end === yend));
}

console.log('\nother purchases stay as they were');
{
  const { db, env } = d1();
  await billing.activate(env, order('pro'), NOW);
  check('Pro alone gives no AI Pass, Studio or Analytics', sub(db, 'ai_pass') === null && sub(db, 'video_subscriptions') === null && sub(db, 'analytics_subscriptions') === null);
  const only = d1();
  await billing.activate(only.env, order('ai-pass'), NOW);
  check('the AI Pass alone gives only the AI Pass', sub(only.db, 'ai_pass')?.status === 'active' && sub(only.db, 'subscriptions') === null && sub(only.db, 'video_subscriptions') === null);
}

console.log('\nthe Suite plan row: 75 API posts a month');
{
  const { db, env } = d1();
  db.prepare(`UPDATE plans SET is_active = 1, coming_soon = 0 WHERE id = 'suite'`).run();   // what the admin does to switch it on
  const row = db.prepare(`SELECT price_cents, yearly_price_cents, limits, features FROM plans WHERE id = 'suite'`).get();
  const limits = JSON.parse(row.limits);
  check('the seed price is $40 a month', row.price_cents === 4000);
  check('the limits say 75 API posts and live API access', limits.apiPostsPerMonth === 75 && limits.apiAccess === 1);
  check('the pricing card lists analytics, AI and the API', /analytics/i.test(row.features) && /AI Pass/i.test(row.features) && /75 API posts/i.test(row.features));
  await plans.refreshPlanSpecs(env);
  const spec = plans.specOf('suite');
  check('the engine reads 75 API posts a month', spec.api === 75);
  const live = { plan: 'suite', status: 'active', lapsed: false, apiAddon: false, currentPeriodEnd: NOW + 1000, overageEnabled: false };
  check('a Suite account may use live API keys', plans.apiAllowed(live) === true);
  check('its API quota is 75 and its dashboard quota stays 1000', plans.limitsFor(live).api === 75 && plans.limitsFor(live).ui === 1000);
}

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
