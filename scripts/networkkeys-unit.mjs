#!/usr/bin/env node
// The admin's check that LinkedIn and Threads keys are really on the server (lib/networkkeys.ts), and that it agrees with
// what opens the connect button for users (linkedinConfigured / threadsConfigured, /api/auth/me → features).
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'vane-unit-'));
const load = async (entry, name) => {
  const out = join(dir, `${name}.mjs`);
  await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent' });
  return import(pathToFileURL(out).href);
};
const { networkKeys, keysMessage } = await load('functions/api/lib/networkkeys.ts', 'keys');
const { linkedinConfigured } = await load('functions/api/channels/linkedin.ts', 'linkedin');
const { threadsConfigured } = await load('functions/api/channels/threads.ts', 'threads');
rmSync(dir, { recursive: true, force: true });

let passed = 0, failed = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) passed++; else failed++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok ? '' : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
};

console.log('\nNothing set');
{
  const k = networkKeys({}, 'threads');
  eq('Threads: not complete, both variables listed as missing', [k.complete, k.vars], [false, [{ name: 'THREADS_APP_ID', set: false }, { name: 'THREADS_APP_SECRET', set: false }]]);
  eq('the message names both variables and where they go', keysMessage(k).startsWith('Code is ready. Add THREADS_APP_ID and THREADS_APP_SECRET (Pages) to open it for users.'), true);
  eq('LinkedIn says Pages and the cron worker', keysMessage(networkKeys({}, 'linkedin')).includes('LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET (Pages and the cron worker)'), true);
}

console.log('\nHalf set, all set');
{
  const half = networkKeys({ THREADS_APP_ID: '123' }, 'threads');
  eq('only the missing one is named', [half.complete, keysMessage(half).includes('Add THREADS_APP_SECRET (')], [false, true]);
  const all = networkKeys({ THREADS_APP_ID: '123', THREADS_APP_SECRET: 's' }, 'threads');
  eq('complete: no message', [all.complete, keysMessage(all)], [true, null]);
}

console.log('\nIt agrees with what opens the connect button for users');
{
  const combos = [{}, { A: '1' }, { id: '1' }, { secret: '1' }, { id: '1', secret: '1' }, { id: '', secret: '1' }, { id: '1', secret: '' }, { id: ' ', secret: ' ' }];
  const rows = combos.map((c) => {
    const li = { ...(c.id !== undefined ? { LINKEDIN_CLIENT_ID: c.id } : {}), ...(c.secret !== undefined ? { LINKEDIN_CLIENT_SECRET: c.secret } : {}) };
    const th = { ...(c.id !== undefined ? { THREADS_APP_ID: c.id } : {}), ...(c.secret !== undefined ? { THREADS_APP_SECRET: c.secret } : {}) };
    return [networkKeys(li, 'linkedin').complete === linkedinConfigured(li), networkKeys(th, 'threads').complete === threadsConfigured(th)];
  });
  eq('same answer as linkedinConfigured / threadsConfigured for every combination (empty values count as missing)', rows.every(([a, b]) => a && b), true);
}

console.log('\nKeys that are there but not seen');
{
  const env = { THREADS_CLIENT_ID: 'sekret-id-123', THREADS_CLIENT_SECRET: 'sekret-value-456', LINKEDIN_CLIENT_ID: 'x', threads_app_id: 'lower' };
  const k = networkKeys(env, 'threads');
  eq('similar names are found (also a lower-case one), sorted', k.similar, ['THREADS_CLIENT_ID', 'THREADS_CLIENT_SECRET', 'threads_app_id']);
  const msg = keysMessage(k);
  eq('the message points at the exact names the code reads', msg.includes('Variables with a similar name exist (THREADS_CLIENT_ID, THREADS_CLIENT_SECRET, threads_app_id), but the code reads exactly THREADS_APP_ID and THREADS_APP_SECRET.'), true);
  eq('a value never appears in the answer', JSON.stringify([k, msg]).includes('sekret'), false);
  eq('LinkedIn variables are not "similar" for Threads', networkKeys({ LINKEDIN_CLIENT_ID: 'x' }, 'threads').similar, []);
  eq('a variable the code does read is not listed as similar', networkKeys({ THREADS_APP_ID: '1' }, 'threads').similar, []);
}

console.log('\nOther networks');
eq('a network without keys of this kind is null', [networkKeys({}, 'bluesky'), networkKeys({}, 'telegram'), networkKeys({}, 'nope')], [null, null, null]);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
