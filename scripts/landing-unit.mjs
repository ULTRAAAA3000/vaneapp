#!/usr/bin/env node
/**
 * The "Follow Vane" cards on the landing page: a long handle (@vaneapp@mastodon.social) must fit its card instead of running into the
 * next one. The script on the page sizes each handle to its card (container units), the cards may shrink (min-w-0), and the handle may
 * wrap as the last resort. Source checks plus the arithmetic of the size rule.   npm run test:unit
 */
import { readFileSync } from 'node:fs';

let passed = 0;
const failed = [];
const check = (name, cond, extra = '') => { if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed.push(name); console.log(`  ✗ ${name} ${extra}`); } };

const page = readFileSync('public/index.html', 'utf8');
const css = readFileSync('public/assets/site.css', 'utf8');
const fitSrc = /function fitSize\(text\) \{[^\n]*\}/.exec(page)?.[0];
check('the page has the fitSize rule', !!fitSrc);
const fitSize = new Function(`${fitSrc}; return fitSize;`)();

console.log('\nthe size rule');
const PX_PER_EM = 16, CHAR_EM = 0.70;   // a character of this font is about 0.69 em wide (measured on "@vaneapp@mastodon.social" at 20 px = 331 px)
const sizePx = (text, innerPx) => {
  const m = /clamp\(([\d.]+)rem,([\d.]+)cqw,([\d.]+)rem\)/.exec(fitSize(text));
  const lo = Number(m[1]) * PX_PER_EM, mid = Number(m[2]) / 100 * innerPx, hi = Number(m[3]) * PX_PER_EM;
  return Math.min(Math.max(mid, lo), hi);
};
const widthOf = (text, innerPx) => text.length * CHAR_EM * sizePx(text, innerPx);
const handles = ['@vanenews', '@vaneapp.bsky.social', '@vaneapp@mastodon.social', '@vaneapp_org', '@a'];
for (const inner of [284, 217]) {   // a 4-column card at 1920 px and at 1280 px (card width minus its padding)
  for (const h of handles) check(`${h.length > 20 ? h.slice(0, 22) + '…' : h} fits a card ${inner}px wide without wrapping`, widthOf(h, inner) <= inner + 0.5, `${widthOf(h, inner).toFixed(0)}px > ${inner}px at ${sizePx(h, inner).toFixed(1)}px`);
}
check('a short handle stays at the full 20 px', sizePx('@vanenews', 284) === 20 && sizePx('@a', 284) === 20);
check('a long one is smaller, never below 12.8 px', sizePx('@vaneapp@mastodon.social', 284) < 20 && sizePx('@' + 'x'.repeat(60), 284) === 12.8);
check('a handle too long to fit even at the smallest size is left to wrap (overflow-wrap:anywhere), so it never runs out of the card', widthOf('@' + 'x'.repeat(24), 217) > 217 && /overflow-wrap:anywhere/.test(page));
check('an empty handle does not break the rule', /^clamp\(/.test(fitSize('')) && /^clamp\(/.test(fitSize(undefined)));

console.log('\nthe cards');
const cardClasses = [...page.matchAll(/class="(reveal glass-d group[^"]*)"/g)].map((m) => m[1]);
const jsCard = /'(reveal glass-d group[^']*)'/.exec(page)?.[1];
check(`every card in the markup (${cardClasses.length}) may shrink and is a size container`, cardClasses.length >= 3 && cardClasses.every((c) => /\bmin-w-0\b/.test(c) && c.includes('[container-type:inline-size]')));
check('the cards the script builds are the same', !!jsCard && /\bmin-w-0\b/.test(jsCard) && jsCard.includes('[container-type:inline-size]'));
const handleTags = [...page.matchAll(/<p class="mt-1 text-xl font-semibold tracking-tight[^"]*"[^>]*>@[^<]*<\/p>/g)].map((m) => m[0]);
check('every handle in the markup can wrap and is sized to its card', handleTags.length >= 3 && handleTags.every((t) => t.includes('[overflow-wrap:anywhere]') && /style="font-size:clamp\(/.test(t)));
check('the script sizes the handles it builds', /h\.style\.fontSize = fitSize\(l\.handle\)/.test(page) && /'mt-1 text-xl font-semibold tracking-tight \[overflow-wrap:anywhere\]'/.test(page));
check('descriptions may wrap too', !/<p class="mt-2 text-sm leading-relaxed text-white\/60">/.test(page.slice(page.indexOf('id="follow"'), page.indexOf('id="follow"') + 8000)));
check('the style sheet has the classes used', ['.min-w-0', '.break-words', '.\\[container-type\\:inline-size\\]', '.\\[overflow-wrap\\:anywhere\\]'].every((c) => css.includes(c)));

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
