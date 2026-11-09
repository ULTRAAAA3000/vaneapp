#!/usr/bin/env node
// Network icons: real brand glyphs (Simple Icons, CC0; LinkedIn keeps its earlier glyph, the library no longer ships it), the same
// glyph in the dashboard (public/assets/dashboard.js) and on the landing (public/index.html), nothing drawn by hand for a brand.
import { readFileSync } from 'node:fs';

const dash = readFileSync('public/assets/dashboard.js', 'utf8');
const home = readFileSync('public/index.html', 'utf8');
let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) passed++; else failed++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok ? '' : `\n      ${detail}`}`);
};

// the dashboard's NET table: name -> { key, fill, d }
const block = dash.slice(dash.indexOf('var NET = {'), dash.indexOf('var NET_ORDER'));
const KEYS = { Telegram: 'telegram', LinkedIn: 'linkedin', Threads: 'threads', Bluesky: 'bluesky', Mastodon: 'mastodon', Discord: 'discord', 'Dev.to': 'devto', Reddit: 'reddit', 'Facebook Pages': 'facebook', Pinterest: 'pinterest', Webhook: 'webhook' };
const nets = {};
for (const m of block.matchAll(/name: '([^']+)'.*?icon: \{ (fill: true, )?d: '([^']+)' \}/gs)) nets[KEYS[m[1]]] = { fill: Boolean(m[2]), d: m[3] };

console.log('\nDashboard');
check('all eleven networks are there', Object.keys(nets).length === 11 && Object.keys(KEYS).every((n) => nets[KEYS[n]]), JSON.stringify(Object.keys(nets)));
check('every brand is a filled glyph, only Webhook (no brand) is a drawn link', Object.entries(nets).every(([k, v]) => (k === 'webhook') !== v.fill), JSON.stringify(Object.entries(nets).filter(([k, v]) => (k === 'webhook') === v.fill).map(([k]) => k)));
check('no icon is empty or tiny', Object.values(nets).every((v) => v.d.length > 60));

console.log('\nLanding');
const icons = JSON.parse(home.match(/var ICONS = (\{.*?\});/s)[1]);
check('the live-feed icons that are not filled are only the two helpers', JSON.stringify(Object.keys(icons).filter((k) => !icons[k].fill).sort()) === JSON.stringify(['arrow', 'other']), JSON.stringify(Object.keys(icons).filter((k) => !icons[k].fill)));
for (const k of ['telegram', 'linkedin', 'threads', 'bluesky', 'mastodon', 'facebook', 'discord', 'reddit']) {
  check(`${k}: the landing and the dashboard use the same glyph`, icons[k] && icons[k].d === nets[k].d, `landing ${String(icons[k] && icons[k].d).slice(0, 40)}…  dashboard ${nets[k].d.slice(0, 40)}…`);
}
check('the hand-drawn Telegram plane is gone from the landing', !home.includes('M21.5 3.5L2.8 10.7') && !dash.includes('M21.5 3.5L2.8 10.7'));
for (const [k, sig] of [['telegram', nets.telegram.d], ['threads', nets.threads.d], ['bluesky', nets.bluesky.d], ['mastodon', nets.mastodon.d], ['linkedin', nets.linkedin.d]]) {
  const used = [...home.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]).filter((d) => d.slice(0, 12) === sig.slice(0, 12));
  check(`${k}: every inline svg on the landing uses the dashboard's glyph`, used.length > 0 && used.every((d) => d === sig), `${used.length} found, ${used.filter((d) => d !== sig).length} differ`);
}
check('no stroke-drawn svg is left for a network (Telegram plane)', !/stroke="currentColor"[^>]*><path d="M21\.5/.test(home));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
