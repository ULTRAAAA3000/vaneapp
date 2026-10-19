#!/usr/bin/env node
/**
 * Unit checks for the pure webhook helpers (URL rules, signature). No server needed:  npm run test:unit
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

let passed = 0; const failed = [];
const check = (name, cond, extra = '') => { if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed.push(name); console.log(`  ✗ ${name} ${extra}`); } };

console.log('\nwebhook URL rules (production)');
const good = ['https://example.com/hooks/vane', 'https://hooks.zapier.com/hooks/catch/123/abc/', 'https://hook.eu1.make.com/abcdef', 'https://api.my-app.io/webhooks?token=x', 'HTTPS://Example.COM/Path'];
for (const u of good) check(`accepts ${u}`, lib.validateWebhookUrl(u).ok === true);
check('normalises the host (lower case)', lib.validateWebhookUrl('HTTPS://Example.COM/Path').url === 'https://example.com/Path');

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
  'https://app.localhost/hook': '*.localhost',
  'https://printer.local/hook': '*.local',
  'https://db.internal/hook': '*.internal',
  'https://intranet/hook': 'a name with no dot',
  'https://example.123/hook': 'a numeric TLD',
  'https://vaneapp.dev/api/v1/me': 'Vane itself',
  'https://post.vaneapp.dev/x': 'a Vane subdomain',
  'not a url': 'not a URL at all',
  '': 'empty',
  [`https://example.com/${'a'.repeat(2100)}`]: 'longer than 2048',
};
for (const [u, why] of Object.entries(bad)) check(`rejects ${why}`, lib.validateWebhookUrl(u).ok === false, u.slice(0, 60));
check('rejects a non-string', lib.validateWebhookUrl(42).ok === false && lib.validateWebhookUrl(null).ok === false);

console.log('\ndev mode (WEBHOOK_DEV_MODE=1, local only)');
check('allows http://localhost:9999/hook', lib.validateWebhookUrl('http://localhost:9999/hook', true).ok === true);
check('allows http://127.0.0.1:9999/hook', lib.validateWebhookUrl('http://127.0.0.1:9999/hook', true).ok === true);
check('still refuses a private IP such as 10.0.0.5', lib.validateWebhookUrl('http://10.0.0.5/hook', true).ok === false);
check('still refuses plain http to a public host', lib.validateWebhookUrl('http://example.com/hook', true).ok === false);
check('production mode refuses localhost', lib.validateWebhookUrl('http://localhost:9999/hook', false).ok === false);

console.log('\nsignature');
const secret = 'whsec_abcDEF123', body = '{"id":"evt_1","type":"ping"}', t = 1790000000;
const expected = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
check('matches an independent HMAC-SHA256 of "<t>.<body>"', (await lib.signWebhook(secret, t, body)) === `t=${t},v1=${expected}`);
check('another body gives another signature', (await lib.signWebhook(secret, t, body + ' ')) !== `t=${t},v1=${expected}`);
check('another secret gives another signature', (await lib.signWebhook(secret + 'x', t, body)) !== `t=${t},v1=${expected}`);
check('another timestamp gives another signature', (await lib.signWebhook(secret, t + 1, body)) !== `t=${t},v1=${expected}`);

console.log('\nsecrets and events');
const s1 = lib.generateWebhookSecret(), s2 = lib.generateWebhookSecret();
check('secret format whsec_ + 32 random characters', /^whsec_[A-Za-z0-9]{32}$/.test(s1.secret));
check('secrets are random', s1.secret !== s2.secret);
check('the hint is the last 4 characters', s1.hint === s1.secret.slice(-4) && lib.displaySecret(s1.hint) === `whsec_••••${s1.hint}`);
check('parseEvents keeps only known events', JSON.stringify(lib.parseEvents('post.sent,bogus,post.cancelled')) === '["post.sent","post.cancelled"]');
check('retry schedule: 1 min, 5 min, 15 min, 1 h, then give up (6 attempts)', JSON.stringify(lib.RETRY_DELAYS) === '[60,300,900,3600]' && lib.MAX_DELIVERY_ATTEMPTS === 6);

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) { console.log('Failed:\n  - ' + failed.join('\n  - ')); process.exit(1); }
