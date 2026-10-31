#!/usr/bin/env node
/**
 * Unit checks for the status badge: the rules behind "All Systems Operational" (functions/api/lib/health.ts, bundled with esbuild)
 * and the badge's pure helpers (public/assets/status.js). No server needed:  npm run test:unit
 */
import { build } from 'esbuild';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

const dir = mkdtempSync(join(tmpdir(), 'vane-unit-'));
const out = join(dir, 'health.mjs');
await build({ entryPoints: ['functions/api/lib/health.ts'], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent' });
const { evaluate, LATE_AFTER_S, STUCK_AFTER_S } = await import(pathToFileURL(out).href);
rmSync(dir, { recursive: true, force: true });

const win = {};
vm.runInNewContext(readFileSync('public/assets/status.js', 'utf8'), { window: win, Math, Date, Array, String, parseInt });
const { median, fmtMs, classify, details } = win.Vane.status;

let passed = 0, failed = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) passed++; else failed++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok ? '' : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
};

const NOW = 1_800_000_000;
console.log('evaluate (server rules)');
eq('nothing waiting: operational', evaluate(true, null, null, NOW).status, 'operational');
eq('a post due right now is fine', evaluate(true, NOW - 30, null, NOW).status, 'operational');
eq('exactly at the limit is still fine', evaluate(true, NOW - LATE_AFTER_S, null, NOW).status, 'operational');
let h = evaluate(true, NOW - LATE_AFTER_S - 1, null, NOW);
eq('a post late by more than 5 minutes: degraded', h.status, 'degraded');
eq('publishing is delayed', h.checks.publishing, 'delayed');
eq('and says for how long', h.delaySeconds, LATE_AFTER_S + 1);
eq('stuck in processing past 10 minutes: degraded', evaluate(true, null, NOW - STUCK_AFTER_S - 5, NOW).status, 'degraded');
eq('processing for 2 minutes is normal', evaluate(true, null, NOW - 120, NOW).status, 'operational');
eq('the longer wait is reported', evaluate(true, NOW - 400, NOW - 900, NOW).delaySeconds, 900);
h = evaluate(false, null, null, NOW);
eq('database not answering: down', h.status, 'down');
eq('publishing is unknown then', h.checks.publishing, 'unknown');

console.log('classify (badge wording)');
eq('operational', classify({ status: 'operational' }, true), { state: 'ok', label: 'All Systems Operational' });
eq('late posts', classify({ status: 'degraded', checks: { publishing: 'delayed' } }, true), { state: 'degraded', label: 'Publishing delayed' });
eq('degraded without detail', classify({ status: 'degraded' }, true).label, 'Degraded performance');
eq('down', classify({ status: 'down' }, true).state, 'down');
eq('no answer at all', classify(null, true), { state: 'unreachable', label: 'Can’t reach Vane' });
eq('offline beats everything', classify({ status: 'operational' }, false).state, 'offline');
eq('garbage answer counts as unreachable', classify({ nope: 1 }, true).state, 'unreachable');

console.log('median / fmtMs');
eq('median of three', median([30, 12, 18]), 18);
eq('median of two', median([10, 20]), 15);
eq('median of none', median([]), null);
eq('18 ms', fmtMs(18.4), '18 ms');
eq('rounds', fmtMs(18.6), '19 ms');
eq('999 ms stays in ms', fmtMs(999), '999 ms');
eq('1.2 s', fmtMs(1234), '1.2 s');

console.log('details (hover text shows only what was measured)');
const t = details({ colo: 'FRA', checks: { database: 'ok', publishing: 'ok' } }, 18.2, '10:00:00');
eq('mentions the edge, round trip, database and publishing', ['Edge: Cloudflare FRA', 'Round trip: 18 ms', 'Database: ok', 'Publishing: on time'].every((s) => t.includes(s)), true);
eq('no edge line when unknown', details({ colo: null, checks: { database: 'ok', publishing: 'ok' } }, 18, '10:00:00').includes('Edge:'), false);
eq('delay in minutes', details({ checks: { database: 'ok', publishing: 'delayed' }, delaySeconds: 420 }, null, '10:00:00').includes('7 min late'), true);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
