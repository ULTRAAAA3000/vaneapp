import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const check = process.argv.includes('--check');
const pub = new URL('../public/', import.meta.url).pathname;
const hash = (f) => createHash('sha1').update(readFileSync(f)).digest('hex').slice(0, 10);
const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? (n === 'assets' || n === 'downloads' ? [] : walk(p)) : p.endsWith('.html') ? [p] : []; });

const stale = [];
let changed = 0;
for (const page of walk(pub)) {
  const src = readFileSync(page, 'utf8');
  const out = src.replace(/(["'])\/assets\/([\w.-]+\.(?:js|css))(?:\?v=[\w.-]*)?\1/g, (m, q, name) => {
    const file = join(pub, 'assets', name);
    if (!existsSync(file)) return m;
    return `${q}/assets/${name}?v=${hash(file)}${q}`;
  });
  if (out !== src) { stale.push(page.slice(pub.length)); if (!check) { writeFileSync(page, out); changed++; } }
}
if (check && stale.length) { console.error('Asset versions are stale in: ' + stale.join(', ') + '\nRun: npm run build:assets'); process.exit(1); }
console.log(check ? 'asset versions are current' : `stamped ${changed} page(s)`);
