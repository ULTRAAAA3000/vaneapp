#!/usr/bin/env node
/**
 * Tests of the prepaid balance (functions/api/lib/balance.ts) against a REAL D1 (Miniflare, in memory): the SQL is what matters here.
 * Parallel spends can never take the same money, a top-up is credited exactly once however often it is reported, the balance can
 * never go negative. No server needed:  npm run test:unit
 */
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'vane-balance-'));
const out = join(dir, 'balance.mjs');
await build({ entryPoints: ['functions/api/lib/balance.ts'], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent' });
const B = await import(pathToFileURL(out).href);

const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok"); } }', d1Databases: { DB: 'balance-test' }, compatibilityDate: '2025-01-01' });
const db = await mf.getD1Database('DB');
const statements = (sql) => sql.split('\n').map((l) => l.split('--')[0]).join('\n').split(';').map((x) => x.trim()).filter(Boolean);
for (const sql of ['CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT)', ...statements(readFileSync('scripts/migrations/009-balance.sql', 'utf8'))]) await db.prepare(sql).run();
await db.prepare(`INSERT INTO users (id, email) VALUES ('u1', 'a@x'), ('u2', 'b@x')`).run();
const env = { DB: db };
const now = 1_800_000_000;
const USD = 1_000_000;

let passed = 0, failed = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) passed++; else failed++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok ? '' : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
};
const bal = (id) => B.getBalanceMicro(env, id);

try {
  console.log('top-up');
  eq('an account with no balance has 0', await bal('u1'), 0);
  eq('the first report of a paid order adds the money', await B.creditTopUp(env, 'u1', 'order-1', 1000, now), true);
  eq('$10 is 10,000,000 micro', await bal('u1'), 10 * USD);
  eq('the same order reported again adds nothing', await B.creditTopUp(env, 'u1', 'order-1', 1000, now), false);
  eq('and the balance is unchanged', await bal('u1'), 10 * USD);
  const again = await Promise.all([1, 2, 3, 4, 5].map(() => B.creditTopUp(env, 'u1', 'order-2', 500, now)));
  eq('five parallel reports of one order credit it once', again.filter(Boolean).length, 1);
  eq('so the balance grew by $5 only', await bal('u1'), 15 * USD);
  eq('a different account is untouched', await bal('u2'), 0);
  eq('a zero amount is not a top-up', await B.creditTopUp(env, 'u1', 'order-3', 0, now), false);

  console.log('spending');
  eq('spending part of it works', await B.chargeBalance(env, 'u1', 20_000, 'ai', now), true);
  eq('and is taken from the balance', await bal('u1'), 15 * USD - 20_000);
  eq('spending more than there is is refused', await B.chargeBalance(env, 'u2', 1, 'post', now), false);
  eq('the balance stays at 0, never negative', await bal('u2'), 0);
  await B.creditTopUp(env, 'u2', 'order-u2', 500, now); // $5 = 250 extra credits of $0.02
  const spends = await Promise.all(Array.from({ length: 400 }, () => B.chargeBalance(env, 'u2', 20_000, 'ai', now)));
  eq('400 parallel $0.02 spends from $5: exactly 250 succeed', spends.filter(Boolean).length, 250);
  eq('and the balance is exactly 0', await bal('u2'), 0);
  eq('a spend of 0 is free and always fine', await B.chargeBalance(env, 'u2', 0, 'post', now), true);

  console.log('refunds');
  await B.refundBalance(env, 'u2', 20_000, 'ai', now);
  eq('a refund puts the money back', await bal('u2'), 20_000);
  await B.refundBalance(env, 'u3-without-row', 20_000, 'ai', now).catch(() => undefined);
  eq('refunding an account that never had a balance row creates it', (await bal('u2')) === 20_000, true);

  console.log('by-hand adjustments');
  eq('adding by hand works', await B.adjustBalance(env, 'u2', 3 * USD, 'gift', now), true);
  eq('taking away more than there is is refused', await B.adjustBalance(env, 'u2', -4 * USD, 'oops', now), false);
  eq('taking away less works', await B.adjustBalance(env, 'u2', -USD, 'correction', now), true);
  eq('the balance is what is left', await bal('u2'), 20_000 + 2 * USD);

  console.log('the database refuses a negative balance by itself');
  let refused = false;
  try { await db.prepare(`UPDATE user_balance SET micro_usd = -1 WHERE user_id = 'u1'`).run(); } catch { refused = true; }
  eq('CHECK (micro_usd >= 0)', refused, true);

  console.log('ledger');
  const led = await B.recentLedger(env, 'u1', 50);
  eq('top-ups are in the ledger once each', led.filter((l) => l.kind === 'topup').length, 2);
  eq('newest first', led[0].kind, 'charge');
  eq('a spend is negative', led[0].usd < 0, true);
} finally {
  await mf.dispose();
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
