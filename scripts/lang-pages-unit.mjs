#!/usr/bin/env node
// The Russian and Ukrainian pages (/ru/…, /uk/…), the hreflang set, the sitemap, robots.txt and llms.txt: what a search engine and an
// AI assistant read. The pages are written by scripts/build-lang-pages.mjs (npm run build:pages).
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { translateBody, loadDict, tokenize, getAttr } from './lang-lib.mjs';

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => { if (ok) passed++; else failed++; console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok ? '' : `\n      ${detail}`}`); };
const ORIGIN = 'https://vaneapp.dev';
const sitemap = readFileSync('public/sitemap.xml', 'utf8');
const enPaths = [...sitemap.matchAll(/<loc>https:\/\/vaneapp\.dev([^<]*)<\/loc>/g)].map((m) => m[1] || '/').filter((p) => !/^\/(ru|uk)(\/|$)/.test(p));
const file = (p, l) => `public/${l === 'en' ? '' : `${l}/`}${p === '/' ? 'index' : p.slice(1)}.html`;
const pages = enPaths.filter((p) => readFileSync(file(p, 'en'), 'utf8').includes('assets/lang.js'));
const url = (p, l) => ORIGIN + (l === 'en' ? p : `/${l}${p === '/' ? '/' : p}`);
const cyr = { ru: /[а-яё]/i, uk: /[а-яіїєґ]/i };

console.log('\nEvery page has a Russian and a Ukrainian twin');
check('the English pages that load lang.js are all localized (at least the 24 marketing pages)', pages.length >= 24, String(pages.length));
for (const l of ['ru', 'uk']) {
  const miss = pages.filter((p) => !existsSync(file(p, l)));
  check(`${l}: a page for each of them`, miss.length === 0, miss.join(', '));
  const stray = readdirSync(`public/${l}`, { recursive: true }).filter((f) => f.endsWith('.html')).map((f) => '/' + f.replace(/\.html$/, '').replace(/^index$/, '')).map((p) => (p === '/' ? '/' : p)).filter((p) => !pages.includes(p));
  check(`${l}: no page without an English original`, stray.length === 0, stray.join(', '));
}

console.log('\nWhat each page says about itself');
const dicts = { ru: loadDict('.', 'ru'), uk: loadDict('.', 'uk') };
for (const l of ['ru', 'uk']) {
  const bad = { lang: [], canon: [], og: [], title: [], desc: [], hreflang: [], block: [], links: [], assets: [], ld: [], untranslated: [] };
  for (const p of pages) {
    const h = readFileSync(file(p, l), 'utf8'), en = readFileSync(file(p, 'en'), 'utf8');
    const head = h.slice(0, h.indexOf('</head>'));
    if (!new RegExp(`<html lang="${l}"`).test(h)) bad.lang.push(p);
    if (!head.includes(`<link rel="canonical" href="${url(p, l)}"`)) bad.canon.push(p);
    if (!head.includes(`property="og:url" content="${url(p, l)}"`)) bad.og.push(p);
    const t = /<title>([\s\S]*?)<\/title>/.exec(head)?.[1] || '', tEn = /<title>([\s\S]*?)<\/title>/.exec(en)?.[1] || '';
    if (!cyr[l].test(t) || t === tEn) bad.title.push(p);
    const d = /<meta name="description" content="([^"]*)"/.exec(head)?.[1] || '';
    if (!cyr[l].test(d)) bad.desc.push(p);
    const set = ['en', 'ru', 'uk'].map((x) => `<link rel="alternate" hreflang="${x}" href="${url(p, x)}" />`).concat(`<link rel="alternate" hreflang="x-default" href="${url(p, 'en')}" />`);
    if (!set.every((x) => head.includes(x))) bad.hreflang.push(p);
    if (!head.includes(`property="og:locale" content="${l === 'ru' ? 'ru_RU' : 'uk_UA'}"`)) bad.block.push(p);
    // links to other localized pages stay in this language
    for (const tk of tokenize(h)) {
      if (tk.t !== 'tag' || !/^<a\s/i.test(tk.s)) continue;
      const href = getAttr(tk.s, 'href') || '';
      const path = href.split(/[?#]/)[0] || '/';
      if (href.startsWith('/') && !href.startsWith('//') && pages.includes(path) && path !== '/' + l) bad.links.push(`${p} → ${href}`);
      if (href === '/' || /^\/[?#]/.test(href)) bad.links.push(`${p} → ${href}`);
      for (const a of ['src', 'href']) { const v = getAttr(tk.s, a); if (v && !/^(\/|#|https?:|mailto:|tel:|data:|javascript:)/.test(v)) bad.assets.push(`${p} ${a}=${v}`); }
    }
    for (const m of h.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
      try { const g = JSON.parse(m[1]); const nodes = g['@graph'] || [g]; if (!nodes.some((n) => n.inLanguage === l)) bad.ld.push(p); } catch { bad.ld.push(p + ' (invalid JSON)'); }
    }
    const { missing } = translateBody(en, dicts[l]);
    const real = [...missing.keys()].filter((s) => !/^(vane|Slack|Hashnode|curl|Elementor|WooCommerce|Next\.js|React|TypeScript|Shopify|GSAP|Figma)$|^@|^\/ \w+$/i.test(s));
    if (real.length) bad.untranslated.push(`${p}: ${real.slice(0, 2).join(' | ')}`);
  }
  const names = { lang: '<html lang>', canon: 'canonical points at its own address', og: 'og:url is its own address', title: 'the title is translated', desc: 'the meta description is translated', hreflang: 'the full hreflang set (en, ru, uk, x-default)', block: 'og:locale of that language', links: 'internal links keep the language', assets: 'no relative asset or link paths', ld: 'JSON-LD is valid and says inLanguage', untranslated: 'every string has a dictionary entry (names aside)' };
  for (const k of Object.keys(names)) check(`${l}: ${names[k]}`, bad[k].length === 0, bad[k].slice(0, 4).join(' ; '));
}

console.log('\nThe three versions point at each other, and at the sitemap');
for (const p of pages) {
  const blocks = ['en', 'ru', 'uk'].map((l) => (/<!-- i18n:start[\s\S]*?<!-- i18n:end -->/.exec(readFileSync(file(p, l), 'utf8')) || [''])[0].split('\n').filter((x) => x.includes('hreflang')).join('\n'));
  if (!(blocks[0] && blocks[0] === blocks[1] && blocks[1] === blocks[2])) { check(`${p}: same hreflang block on en, ru and uk`, false, 'differs'); break; }
}
check('every version of every page is in the sitemap with its alternates', pages.every((p) => ['en', 'ru', 'uk'].every((l) => new RegExp(`<loc>${url(p, l).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</loc>(?:<lastmod>[^<]*</lastmod>)?<xhtml:link rel="alternate" hreflang="en" href="${url(p, 'en').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"/>`).test(sitemap))));
check('the sitemap declares the xhtml namespace', sitemap.includes('xmlns:xhtml="http://www.w3.org/1999/xhtml"'));
check('legal pages that exist only in English are listed once, without alternates', /<url><loc>https:\/\/vaneapp\.dev\/privacy<\/loc>(<lastmod>[^<]*<\/lastmod>)?<\/url>/.test(sitemap));

console.log('\nThe language switch (assets/lang.js)');
const lj = readFileSync('public/assets/lang.js', 'utf8');
check('a language button goes to that language’s page when the page has hreflang twins', /function go\(code, replace\)/.test(lj) && /if \(!go\(to, false\)\) set\(to, true\)/.test(lj));
check('on a translated page the address decides the language, whatever was saved', /if \(PAGE !== 'en'\) want = PAGE;/.test(lj));
check('on the English page a saved or ?lang= language goes to its page', /go\(want, true\)\) return;/.test(lj));

console.log('\nFor AI assistants');
const robots = readFileSync('public/robots.txt', 'utf8');
for (const bot of ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-SearchBot', 'PerplexityBot', 'Google-Extended']) {
  const g = new RegExp(`User-agent: ${bot}\\n([^\\n]*\\n)*?\\n`).exec(robots)?.[0] || '';
  check(`robots.txt: ${bot} is welcome and the private paths stay closed`, /Allow: \//.test(g) && /Disallow: \/api\//.test(g) && /Disallow: \/admin/.test(g), g);
}
check('robots.txt names the sitemap', /Sitemap: https:\/\/vaneapp\.dev\/sitemap\.xml/.test(robots));
for (const [l, path, words] of [['en', 'public/llms.txt', ['autoposter', '$11.99', 'no per-channel fees', '/pricing']], ['ru', 'public/ru/llms.txt', ['автопостер', '$11.99', 'без платы за канал', '/ru/pricing']], ['uk', 'public/uk/llms.txt', ['автопостер', '$11.99', 'без плати за канали', '/uk/pricing']]]) {
  const t = existsSync(path) ? readFileSync(path, 'utf8') : '';
  check(`llms.txt (${l}) exists, starts with the product name and a summary`, /^# Vane\n\n> /.test(t));
  check(`llms.txt (${l}) carries the facts people ask about: ${words.join(', ')}`, words.every((w) => t.includes(w)), words.filter((w) => !t.includes(w)).join(', '));
  check(`llms.txt (${l}) links to the pages of that language and to the other two files`, ['llms.txt'].every(() => t.includes('https://vaneapp.dev/llms.txt') || l === 'en') && t.includes('/ru/llms.txt') && t.includes('/uk/llms.txt') || (l === 'ru' && t.includes('/uk/llms.txt') && t.includes('vaneapp.dev/llms.txt')) || (l === 'uk' && t.includes('/ru/llms.txt') && t.includes('vaneapp.dev/llms.txt')));
}
const hdr = readFileSync('public/_headers', 'utf8');
check('llms.txt files are served as UTF-8 text', ['/llms.txt', '/ru/llms.txt', '/uk/llms.txt'].every((p) => new RegExp(`${p.replace('/', '\\/')}\\n  Content-Type: text\\/plain; charset=utf-8`).test(hdr)));
const home = readFileSync('public/index.html', 'utf8');
check('the English home title and description say autoposter and affordable', /<title>[^<]*[Aa]utoposter[^<]*<\/title>/.test(home) && /<meta name="description" content="Affordable autoposter/.test(home));
check('the home FAQ answers "Is Vane an affordable autoposter?" in the page and in the structured data', home.includes('Is Vane an affordable autoposter?') && (home.match(/Is Vane an affordable autoposter\?/g) || []).length >= 2);
for (const l of ['ru', 'uk']) {
  const h = readFileSync(`public/${l}/index.html`, 'utf8');
  check(`${l}: the home page title mentions the autoposter in that language`, /<title>[^<]*автопостер[^<]*<\/title>/.test(h));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
