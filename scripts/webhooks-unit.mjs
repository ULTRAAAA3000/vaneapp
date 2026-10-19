#!/usr/bin/env node
/**
 * Unit checks for the pure webhook helpers: which receiver addresses Vane is willing to call (SSRF rules) and the signature.
 * No server needed:  npm run test:unit
 * The TypeScript is bundled on the fly with esbuild (it ships with wrangler).
 */
import { build } from 'esbuild';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'vane-unit-'));
const out = join(dir, 'webhooks.mjs');
await build({ entryPoints: ['functions/api/lib/webhooks.ts'], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent' });
const lib = await import(pathToFileURL(out).href);
rmSync(dir, { recursive: true, force: true });

let passed = 0;
const failed = [];
const check = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed.push(name); console.log(`  ✗ ${name} ${extra}`); }
};

console.log('\nwebhook URL rules');
const good = [
  'https://example.com/hooks/vane',
  'https://hooks.zapier.com/hooks/catch/123/abc/',
  'https://hook.eu1.make.com/abcdef',
  'https://api.my-app.io/webhooks?token=x',
  'https://vaneapp.dev.example.org/hook', // merely resembles our name
  'https://notvaneapp.dev/hook',
];
for (const u of good) check(`accepts ${u}`, typeof lib.validateWebhookUrl(u) === 'string');
check('normalises the host (lower case)', lib.validateWebhookUrl('HTTPS://Example.COM/Path') === 'https://example.com/Path');

const bad = {
  'http://example.com/hook': 'plain http',
  'ftp://example.com/hook': 'another scheme',
  'https://user:pass@example.com/hook': 'credentials in the URL',
  'https://example.com:8443/hook': 'a non-standard port',
  'https://127.0.0.1/hook': 'loopback IP',
  'https://10.0.0.5/hook': 'private IP',
  'https://169.254.169.254/latest/meta-data': 'cloud metadata IP',
  'https://192.168.1.10/hook': 'LAN IP',
  'https://0x7f.0.0.1/hook': 'hex-encoded loopback (the URL parser turns it into 127.0.0.1)',
  'https://2130706433/hook': 'decimal-encoded loopback',
  'https://[::1]/hook': 'IPv6 loopback',
  'https://[fd00::1]/hook': 'IPv6 private',
  'https://localhost/hook': 'localhost',
  'https://localhost./hook': 'localhost with a trailing dot',
  'https://app.localhost/hook': '*.localhost',
  'https://printer.local/hook': '*.local',
  'https://db.internal/hook': '*.internal',
  'https://router.home.arpa/hook': '*.home.arpa',
  'https://wiki.intranet/hook': '*.intranet',
  'https://intranet/hook': 'a name with no dot',
  'https://example.123/hook': 'a numeric TLD',
  'https://vaneapp.dev/api/v1/me': 'Vane itself',
  'https://VaneApp.dev./api/v1/me': 'Vane itself, upper case and trailing dot',
  'https://post.vaneapp.dev/x': 'a Vane subdomain',
  'https://studio.vaneapp.dev/x': 'a Vane subdomain (studio)',
  'not a url': 'not a URL at all',
  '': 'empty',
  [`https://example.com/${'a'.repeat(2100)}`]: 'longer than 2048',
};
for (const [u, why] of Object.entries(bad)) check(`rejects ${why}`, lib.validateWebhookUrl(u) === null, u.slice(0, 60));
check('rejects a non-string', lib.validateWebhookUrl(42) === null && lib.validateWebhookUrl(null) === null && lib.validateWebhookUrl(undefined) === null);

console.log('\nsignature');
const secret = 'whsec_abcDEF123', body = '{"id":"evt_1","type":"ping"}', t = 1790000000;
const expected = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
check('matches an independent HMAC-SHA256 of "<t>.<body>"', (await lib.signWebhook(secret, t, body)) === `t=${t},v1=${expected}`);
check('another body gives another signature', (await lib.signWebhook(secret, t, body + ' ')) !== `t=${t},v1=${expected}`);
check('another secret gives another signature', (await lib.signWebhook(secret + 'x', t, body)) !== `t=${t},v1=${expected}`);
check('another timestamp gives another signature', (await lib.signWebhook(secret, t + 1, body)) !== `t=${t},v1=${expected}`);

console.log('\nsecrets and retries');
const s1 = lib.newWebhookSecret(), s2 = lib.newWebhookSecret();
check('secret format whsec_ + 48 hex characters', /^whsec_[0-9a-f]{48}$/.test(s1));
check('secrets are random', s1 !== s2);
check('retry schedule grows: 1 min, 5 min, 30 min, 2 h, 12 h', [1, 2, 3, 4, 5].map((n) => lib.backoffForAttempt(n)).join() === '60,300,1800,7200,43200');

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) { console.log('Failed:\n  - ' + failed.join('\n  - ')); process.exit(1); }
