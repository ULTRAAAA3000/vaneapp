#!/usr/bin/env node
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'vane-unit-'));
const out = join(dir, 'billing.mjs');
await build({ entryPoints: ['functions/api/lib/billing.ts'], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent' });
const { billingMethods, billingEnabled } = await import(pathToFileURL(out).href);
rmSync(dir, { recursive: true, force: true });

let passed = 0, failed = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) passed++; else failed++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok ? '' : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
};

const keys = { MONOBANK_TOKEN: 'x'.repeat(20), CRYPTO_WALLET: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin' };
eq('keys alone show nothing: the methods are hidden until listed', billingMethods(keys), { csob: false, monobank: false, crypto: false, paypal: false });
eq('listed and configured: shown', billingMethods({ ...keys, PAYMENT_METHODS: 'crypto, Monobank' }), { csob: false, monobank: true, crypto: true, paypal: false });
eq('only crypto listed', billingMethods({ ...keys, PAYMENT_METHODS: 'crypto' }), { csob: false, monobank: false, crypto: true, paypal: false });
eq('listed but not configured: still off', billingMethods({ PAYMENT_METHODS: 'monobank,crypto' }), { csob: false, monobank: false, crypto: false, paypal: false });
eq('billingEnabled follows the list', [billingEnabled(keys), billingEnabled({ ...keys, PAYMENT_METHODS: 'monobank' })], [false, true]);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
