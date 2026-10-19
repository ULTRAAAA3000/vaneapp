import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const spec = JSON.parse(readFileSync('public/vane-openapi.json', 'utf8'));
const known = new Set();
for (const [path, item] of Object.entries(spec.paths)) {
  for (const method of Object.keys(item)) {
    if (['get', 'post', 'put', 'patch', 'delete'].includes(method)) known.add(`${method.toUpperCase()} ${path.replace(/^\/api\/v1/, '').replace(/\{(\w+)\}/g, '{{id}}')}`);
  }
}

const dirs = [['modules', 'module'], ['rpcs', 'rpc'], ['connections', 'connection']];
let bad = 0;
let checked = 0;
for (const [dir] of dirs) {
  const base = join('integrations/make', dir);
  for (const name of readdirSync(base)) {
    const file = join(base, name, `${name}.communication.json`);
    const c = JSON.parse(readFileSync(file, 'utf8'));
    const url = c.url.replace(/\{\{parameters\.\w+\}\}/g, '{{id}}');
    checked++;
    if (!known.has(`${c.method} ${url}`)) {
      bad++;
      console.error(`FAIL ${file}: ${c.method} ${c.url} is not in public/vane-openapi.json`);
    }
  }
}
// Zapier: every `${BASE}/path` the app calls must exist in the spec (any method)
const specPaths = new Set(Object.keys(spec.paths).map((p) => p.replace(/^\/api\/v1/, '')));
for (const dir of ['integrations/zapier/triggers', 'integrations/zapier/creates', 'integrations/zapier']) {
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    const src = readFileSync(join(dir, name), 'utf8');
    for (const m of src.matchAll(/\$\{BASE\}(\/[a-z]+)/g)) {
      checked++;
      if (!specPaths.has(m[1])) { bad++; console.error(`FAIL ${join(dir, name)}: ${m[1]} is not in public/vane-openapi.json`); }
    }
  }
}
if (bad) process.exit(1);
console.log(`ok: ${checked} Make/Zapier calls match the OpenAPI spec`);
