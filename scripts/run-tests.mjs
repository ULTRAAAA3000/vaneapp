#!/usr/bin/env node
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const files = readdirSync('scripts').filter((f) => f.endsWith('-unit.mjs')).sort();
const steps = [...files.map((f) => ['--no-warnings', `scripts/${f}`]), ['scripts/stamp-assets.mjs', '--check']];
let failed = 0;
for (const args of steps) {
  const r = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (r.status !== 0) { failed++; console.error(`FAILED: ${args.join(' ')}`); }
}
process.exit(failed ? 1 : 0);
