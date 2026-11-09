#!/usr/bin/env node
/**
 * Modules on/off (admin → Modules): the registry, the stored switch, the public list, the API gate in the middleware, and that every
 * page hook (data-module) points at a real module and no page carries a hand-written "Soon" for a module any more.   npm run test:unit
 */
import { build } from 'esbuild';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'vane-unit-'));
const root = process.cwd();
writeFileSync(join(dir, 'entry.ts'), [
  `export * as modules from '${root}/functions/api/lib/modules.ts';`,
  `export * as pub from '${root}/functions/api/modules.ts';`,
  `export * as mw from '${root}/functions/_middleware.ts';`,
  `export * as settings from '${root}/functions/api/lib/settings.ts';`,
].join('\n'));
await build({ entryPoints: [join(dir, 'entry.ts')], bundle: true, format: 'esm', platform: 'node', outfile: join(dir, 'all.mjs'), logLevel: 'silent' });
const { modules, pub, mw, settings } = await import(pathToFileURL(join(dir, 'all.mjs')).href);
rmSync(dir, { recursive: true, force: true });

let passed = 0;
const failed = [];
const check = (name, cond, extra = '') => { if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed.push(name); console.log(`  ✗ ${name} ${extra}`); } };

function make() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync('schema.sql', 'utf8'));
  const mk = (sql) => ({
    args: [],
    bind(...a) { const c = mk(sql); c.args = a; return c; },
    async first() { return db.prepare(sql).get(...this.args) ?? null; },
    async run() { const r = db.prepare(sql).run(...this.args); return { success: true, meta: { changes: Number(r.changes) } }; },
    async all() { return { results: db.prepare(sql).all(...this.args) }; },
  });
  return { db, env: { ENCRYPTION_KEY: 'k'.repeat(40), DB: { prepare: mk, async batch(st) { const o = []; for (const s of st) o.push(await s.run()); return o; } } } };
}

console.log('\nRegistry');
check('ids are unique', new Set(modules.MODULES.map((m) => m.id)).size === modules.MODULES.length);
check('API prefixes belong to one module each', modules.MODULES.flatMap((m) => m.api).length === new Set(modules.MODULES.flatMap((m) => m.api)).size);
check('paths map to their module', modules.moduleOfPath('/api/video/upload') === 'studio' && modules.moduleOfPath('/api/v1/video/x') === 'studio' && modules.moduleOfPath('/api/analytics/bot') === 'analytics' && modules.moduleOfPath('/api/ai') === 'ai' && modules.moduleOfPath('/api/library/assets/') === 'library');
check('lookalike paths do not', modules.moduleOfPath('/api/airplane') === null && modules.moduleOfPath('/api/posts') === null && modules.moduleOfPath('/api/admin/modules') === null && modules.moduleOfPath('/api/modules') === null && modules.moduleOfPath('/api/v1/posts') === null);

console.log('\nThe switch');
{
  const { env } = make();
  check('everything is on by default', (await modules.disabledModules(env)).length === 0);
  check('switching a module off stores it', (await modules.setModule(env, 'studio', false)) === null && (await modules.disabledModules(env)).join() === 'studio');
  await modules.setModule(env, 'ai', false);
  await modules.setModule(env, 'studio', false);
  check('two off, no duplicates, in registry order', (await modules.disabledModules(env)).join() === 'studio,ai');
  await modules.setModule(env, 'studio', true);
  check('switching one on leaves the other off', (await modules.disabledModules(env)).join() === 'ai');
  await modules.setModule(env, 'ai', true);
  check('all on again', (await modules.disabledModules(env)).length === 0);
  await env.DB.prepare(`INSERT INTO settings (key, value) VALUES ('modules_off', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(JSON.stringify('nonsense,ai,,library')).run();
  settings.invalidateSettings();
  check('unknown ids in the stored value are ignored', (await modules.disabledModules(env)).join() === 'ai,library');
  check('other settings are untouched', (await settings.getSettings(env)).registration_open === true);
  const res = await pub.onRequestGet({ env });
  const body = await res.json();
  check('the public list answers without signing in', res.status === 200 && body.ok && body.off.join() === 'ai,library');
  check('and can be cached for a few seconds', /max-age=15/.test(res.headers.get('cache-control')));
}

console.log('\nThe API gate');
{
  settings.invalidateSettings();
  const { env } = make();
  const ctx = (path, method = 'GET') => ({
    request: new Request(`https://localhost${path}`, { method, headers: { 'cf-connecting-ip': '203.0.113.7' } }),
    env, waitUntil() {}, next: async () => new Response(JSON.stringify({ ok: true, reached: true }), { headers: { 'content-type': 'application/json' } }),
    params: {}, data: {}, functionPath: path,
  });
  const hit = async (path) => { const r = await mw.onRequest(ctx(path)); let b = null; try { b = await r.json(); } catch { /* */ } return { status: r.status, body: b }; };
  { const r = await hit('/api/ai/generate'); check('on: a module API is reached', r.body?.reached === true, JSON.stringify(r)); }
  await modules.setModule(env, 'ai', false);
  await modules.setModule(env, 'analytics', false);
  const off = await hit('/api/ai/generate');
  check('off: 503 module_disabled with a sentence a page can show', off.status === 503 && off.body.code === 'module_disabled' && off.body.module === 'ai' && /check back later/i.test(off.body.error), JSON.stringify(off));
  check('off: the other module-off path too', (await hit('/api/analytics/bot')).status === 503);
  check('off: other APIs are not touched', (await hit('/api/posts')).body?.reached === true && (await hit('/api/library/assets')).body?.reached === true);
  check('the public list stays reachable', (await hit('/api/modules')).body?.reached === true);
  check('the admin can still manage them', (await hit('/api/admin/modules')).status !== 503);
  await modules.setModule(env, 'ai', true);
  check('switched on again: reached at once', (await hit('/api/ai/generate')).body?.reached === true);
}

console.log('\nPages');
{
  const ids = new Set(modules.MODULES.map((m) => m.id));
  const files = readdirSync('public').filter((f) => f.endsWith('.html'));
  let bad = [];
  for (const f of files) {
    const html = readFileSync(join('public', f), 'utf8');
    for (const m of html.matchAll(/data-module(?:-badge|-page)?="([\w-]+)"/g)) if (!ids.has(m[1])) bad.push(`${f}: ${m[1]}`);
  }
  check('every data-module hook points at a real module', bad.length === 0, bad.join(', '));
  const app = readFileSync('public/app.html', 'utf8');
  const tabs = [...app.matchAll(/data-tab="(\w+)" data-module="(\w+)"/g)];
  check('a dashboard tab and its module have the same name', tabs.length >= 10 && tabs.every((t) => t[1] === t[2]), String(tabs.length));
  check('the pages that show modules load modules.js', ['app.html', 'studio.html', 'analytics.html', 'index.html'].every((f) => /\/assets\/modules\.js/.test(readFileSync(join('public', f), 'utf8'))));
  check('Studio and Analytics pages ask for their own dialog', /data-module-page="studio"/.test(readFileSync('public/studio.html', 'utf8')) && /data-module-page="analytics"/.test(readFileSync('public/analytics.html', 'utf8')));
  const hand = ['app.html', 'studio.html', 'analytics.html'].filter((f) => /\(soon\)|· Soon|: soon\./i.test(readFileSync(join('public', f), 'utf8')));
  check('no hand-written "Soon" left in the dashboards', hand.length === 0, hand.join(', '));
  check('the Soon labels on the landing page for Studio are switched by the module, not fixed', !/>Coming soon<\/span>/.test(readFileSync('public/index.html', 'utf8').split('<script')[0].replace(/data-module-badge="studio" hidden[^>]*>Coming soon<\/span>/g, '')));
  const js = readFileSync('public/assets/modules.js', 'utf8');
  check('the dialog is a custom one, not alert()/confirm()', !/\b(alert|confirm)\(/.test(js) && /role="dialog"/.test(js) && /Please check back later/.test(js));
  const adm = readFileSync('public/assets/admin.js', 'utf8');
  check('the admin has a Modules tab and a toggle', /\['modules', 'Modules'\]/.test(adm) && /mod-toggle/.test(adm) && /VIEWS\.modules/.test(adm));
}

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) { console.log('Failed:\n - ' + failed.join('\n - ')); process.exit(1); }
