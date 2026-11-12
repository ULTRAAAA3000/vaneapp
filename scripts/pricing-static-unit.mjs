#!/usr/bin/env node
// Prices an AI assistant or a search engine can read WITHOUT running JavaScript: /pricing (and its Russian and Ukrainian twins) holds the
// plans in its HTML, from scripts/plans-snapshot.json, drawn with the same function the page script uses (assets/plan-card.js).
// /autoposter, the page written for "affordable autoposter" questions, is checked here too.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => { if (ok) passed++; else failed++; console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok ? '' : `\n      ${detail}`}`); };
const text = (html) => html.slice(html.indexOf('<body')).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

const ctx = { module: { exports: {} }, Intl };
vm.runInNewContext(readFileSync('public/assets/plan-card.js', 'utf8'), ctx);
const { card, fmt } = ctx.module.exports;
const PLANS = JSON.parse(readFileSync('scripts/plans-snapshot.json', 'utf8'));
const by = Object.fromEntries(PLANS.map((p) => [p.id, p]));

console.log('\nThe plan card');
const pro = card(by.pro, 'month');
check('Pro shows $11.99, the crossed-out $14.99, the Early Bird badge and the buy link', pro.includes('$11.99') && pro.includes('line-through">$14.99') && pro.includes('Early Bird') && pro.includes('/checkout?plan=pro'), pro.slice(0, 200));
check('the yearly view shows $120 a year', card(by.pro, 'year').includes('$120') && card(by.pro, 'year').includes('/ year'));
check('the free plan shows $0 and a start-free link; the coming-soon plan shows no buy link', card(by.free, 'month').includes('$0') && card(by.free, 'month').includes('Start free') && !card(by.video, 'month').includes('/checkout'));
check('text from a plan is escaped', card({ ...by.api, name: '<b>x</b>' }, 'month').includes('&lt;b&gt;x&lt;/b&gt;'));
check('pricing.js uses the shared function and does not carry its own copy of the markup', /VanePlanCard\.card/.test(readFileSync('public/assets/pricing.js', 'utf8')) && !/glass-d card relative/.test(readFileSync('public/assets/pricing.js', 'utf8')));

console.log('\nThe snapshot matches what the site says and what the database is seeded with');
const home = text(readFileSync('public/index.html', 'utf8'));
for (const [id, price] of [['api', '$7.99'], ['pro', '$11.99'], ['video', '$14.99']]) check(`${by[id].name}: ${price} is also on the landing page`, home.includes(price) && fmt(by[id].priceCents, 'USD') === price);
const schema = readFileSync('schema.sql', 'utf8');
check('the snapshot prices are the seeded ones (api 799, pro 1199, studio 1499)', [['api', 799], ['pro', 1199], ['video', 1499]].every(([id, c]) => by[id].priceCents === c && new RegExp(`\\('${id}',[^)]*?,\\s*${c},`).test(schema)));
check('the Pro compare and yearly prices are the seeded ones', by.pro.comparePriceCents === 1499 && by.pro.yearlyPriceCents === 12000 && /'Early Bird', 1199, 1499, 12000/.test(schema));

console.log('\nWhat the HTML says before any script runs');
for (const [l, path] of [['en', 'public/pricing.html'], ['ru', 'public/ru/pricing.html'], ['uk', 'public/uk/pricing.html']]) {
  const html = readFileSync(path, 'utf8'), t = text(html);
  check(`${l}: /pricing lists the plans and their prices`, ['$0', '$7.99', '$11.99', '$14.99'].every((p) => t.includes(p)) && ['Free Trial', 'Developer API', 'Pro Dashboard'].every((n) => t.includes(n)), t.slice(t.indexOf('Pricing'), t.indexOf('Pricing') + 200));
  const dict = l === 'en' ? { 'Loading the plans…': 'Loading the plans…' } : JSON.parse(readFileSync(`public/assets/lang-${l}.js`, 'utf8').replace(/^[^{]*/, '').replace(/;?\s*$/, ''));
  check(`${l}: no "Loading the plans" placeholder is left in the HTML`, !t.includes(dict['Loading the plans…'] || 'Loading the plans…'));
  const ld = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1])).flatMap((g) => g['@graph'] || [g]);
  const offers = ld.filter((n) => n.offers).flatMap((n) => n.offers);
  check(`${l}: structured data carries an Offer for each plan with its price`, ['0.00', '7.99', '11.99'].every((p) => offers.some((o) => o.price === p && o.priceCurrency === 'USD')), JSON.stringify(offers.map((o) => o.price)));
}
check('Russian and Ukrainian /pricing carry the plan text in that language, not only the English one', /Без карти|Не потрібна картка|картка не потрібна/i.test(text(readFileSync('public/uk/pricing.html', 'utf8'))) && /Карта не нужна|без карты/i.test(text(readFileSync('public/ru/pricing.html', 'utf8'))));

console.log('\n/autoposter');
const sitemap = readFileSync('public/sitemap.xml', 'utf8');
for (const [l, path, url] of [['en', 'public/autoposter.html', 'https://vaneapp.dev/autoposter'], ['ru', 'public/ru/autoposter.html', 'https://vaneapp.dev/ru/autoposter'], ['uk', 'public/uk/autoposter.html', 'https://vaneapp.dev/uk/autoposter']]) {
  const html = readFileSync(path, 'utf8'), t = text(html);
  check(`${l}: the page exists, is canonical to itself and sits in the sitemap`, html.includes(`<link rel="canonical" href="${url}"`) && sitemap.includes(`<loc>${url}</loc>`));
  check(`${l}: it shows the plan table with the prices`, ['$7.99', '$11.99', '$14.99'].every((p) => t.includes(p)));
  const ld = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1])).flatMap((g) => g['@graph'] || [g]);
  const faq = ld.find((n) => n['@type'] === 'FAQPage');
  check(`${l}: four questions, each in the page and in the structured data`, faq && faq.mainEntity.length === 4 && faq.mainEntity.every((q) => t.includes(q.name.replace(/&/g, '&'))), faq ? faq.mainEntity.map((q) => q.name.slice(0, 30)).join(' | ') : 'no FAQPage');
}
check('every page links to it from the footer, in its own language', [['public/index.html', '/autoposter'], ['public/pricing.html', '/autoposter'], ['public/networks/slack.html', '/autoposter'], ['public/ru/about.html', '/ru/autoposter'], ['public/uk/networks/slack.html', '/uk/autoposter']].every(([f, h]) => readFileSync(f, 'utf8').includes(`href="${h}"`)));
check('llms.txt in all three languages links to it', ['public/llms.txt', 'public/ru/llms.txt', 'public/uk/llms.txt'].every((f) => /vaneapp\.dev\/(ru\/|uk\/)?autoposter/.test(readFileSync(f, 'utf8'))));
check('the home page structured data names the brand the way people search for it', /"alternateName":\["Vane autoposter","Vane social media scheduler"\]/.test(readFileSync('public/index.html', 'utf8')) && /"alternateName":\["Vane Post","vaneapp\.dev"\]/.test(readFileSync('public/index.html', 'utf8')));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
