#!/usr/bin/env node
/**
 * Unit tests of the post box's "Tidy up" rules (public/assets/composer-tools.js → VaneTidy). No server needed:
 *
 *   npm run test:composer
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const code = readFileSync(new URL('../public/assets/composer-tools.js', import.meta.url), 'utf8');
const ctx = vm.createContext({});
vm.runInContext(code, ctx);
const { tidy, describe } = ctx.VaneTidy;

let passed = 0;
const failures = [];
const eq = (name, got, want) => {
  if (got === want) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`); }
};
const section = (t) => console.log(`\n${t}`);
const t = (s) => tidy(s).text;

section('Spaces and line breaks');
eq('Windows line breaks become plain ones', t('a\r\nb\rc'), 'a\nb\nc');
eq('extra spaces between words collapse', t('one   two    three'), 'one two three');
eq('tabs become a space', t('a\t\tb'), 'a b');
eq('spaces at the start and end of a line go', t('  hello  \n   world   '), 'hello\nworld');
eq('a no-break space and typographic spaces become plain spaces', t('a\u00A0b\u2003c\u202Fd'), 'a b c d');
eq('three or more blank lines become one', t('a\n\n\n\n\nb'), 'a\n\nb');
eq('one blank line between paragraphs is kept', t('a\n\nb'), 'a\n\nb');
eq('blank lines at the start and the end go', t('\n\n\na\n\n\n'), 'a');
eq('a line of only spaces counts as blank', t('a\n   \n \t \nb'), 'a\n\nb');
eq('only whitespace gives an empty text', t(' \n \n\t '), '');

section('Hidden characters');
eq('zero-width space, word joiner, BOM and soft hyphen go', t('a\u200Bb\u2060c\uFEFFd\u00ADe'), 'abcde');
eq('the zero-width joiner stays: family emoji is not broken', t('👨‍👩‍👧 hi'), '👨‍👩‍👧 hi');
eq('the zero-width non-joiner stays: Persian text is not broken', t('می‌خواهم'), 'می‌خواهم');
eq('the right-to-left mark stays', t('a\u200Fb'), 'a\u200Fb');
eq('the CJK ideographic space stays', t('你好\u3000世界'), '你好\u3000世界');
eq('emoji and accents are untouched', t('Café ☕ — naïve 🚀'), 'Café ☕ — naïve 🚀');

section('Links: tracking parameters go, real ones stay');
eq('utm_* are removed, the rest and the #fragment stay', t('https://a.com/x?utm_source=tw&id=5&utm_medium=social#top'), 'https://a.com/x?id=5#top');
eq('a link with only tracking loses its "?" altogether', t('https://a.com/x?utm_source=tw&fbclid=abc'), 'https://a.com/x');
eq('fbclid, gclid, msclkid, igshid and mc_eid are tracking', t('https://a.com/?fbclid=1&gclid=2&msclkid=3&igshid=4&mc_eid=5&q=hi'), 'https://a.com/?q=hi');
eq('real parameters (ref, v, id, page) are never touched', t('https://github.com/o/r?ref=main&v=3&page=2'), 'https://github.com/o/r?ref=main&v=3&page=2');
eq('"si" is a share id on YouTube and Spotify: removed', t('https://youtu.be/abc?si=XYZ&t=30'), 'https://youtu.be/abc?t=30');
eq('"si" elsewhere is a real parameter: kept', t('https://shop.example/p?si=42'), 'https://shop.example/p?si=42');
eq('the punctuation after a link is not part of it', t('See https://a.com/p?utm_source=x.'), 'See https://a.com/p.');
eq('a link in brackets keeps the closing bracket', t('(https://a.com/p?fbclid=1)'), '(https://a.com/p)');
eq('a bracket that belongs to the link stays with it', t('https://en.wikipedia.org/wiki/Heat_(film)?utm_source=a'), 'https://en.wikipedia.org/wiki/Heat_(film)');
eq('a link without parameters is left exactly as it was', t('https://a.com/x/y_(z)#p'), 'https://a.com/x/y_(z)#p');
eq('uppercase UTM_SOURCE is caught too', t('https://a.com/?UTM_SOURCE=x&id=1'), 'https://a.com/?id=1');
eq('several links in one text', t('a https://x.com/?utm_a=1 b https://y.com/?gclid=2&k=v'), 'a https://x.com/ b https://y.com/?k=v');
eq('a percent-encoded name still matches', t('https://a.com/?utm%5Fsource=x&id=1'), 'https://a.com/?id=1');
eq('a broken percent sequence does not crash', t('https://a.com/?%E0%A4%A=1&utm_source=x'), 'https://a.com/?%E0%A4%A=1');

section('Behaviour');
eq('tidying twice gives the same as once', t(t('  a   b \n\n\n\n c https://z.com/?utm_x=1 ')), t('  a   b \n\n\n\n c https://z.com/?utm_x=1 '));
{
  const clean = tidy('Already clean.\n\nSecond paragraph https://a.com/x?id=1');
  eq('a clean text is reported as unchanged', clean.changed, false);
  eq('and comes back identical', clean.text, 'Already clean.\n\nSecond paragraph https://a.com/x?id=1');
}
eq('empty input is fine', t(''), '');
eq('null and undefined are fine', t(null) + t(undefined), '');
eq('a long text with mixed mess is tidied in one go', t('\uFEFFHello   world \n\n\n\n  New\u00A0line\t\there https://a.com/?utm_source=x&q=1\n\n\n'), 'Hello world\n\nNew line here https://a.com/?q=1');

section('The report');
{
  const r = tidy('a  b\n\n\n\nc\u200B https://x.com/?utm_a=1&utm_b=2 https://y.com/?fbclid=3');
  eq('counts the blank lines', r.changes.blankLines, 2);
  eq('counts the extra spaces', r.changes.spaces >= 1, true);
  eq('counts the hidden characters', r.changes.invisible, 1);
  eq('counts the tracking parameters and the links', `${r.changes.params}/${r.changes.links}`, '3/2');
  eq('says it in words', describe(r.changes), 'Removed 2 extra blank lines, ' + r.changes.spaces + ' extra space' + (r.changes.spaces === 1 ? '' : 's') + ', 1 hidden character and 3 tracking parameters in 2 links.');
  eq('one thing removed reads naturally', describe({ blankLines: 0, spaces: 0, invisible: 0, params: 1, links: 1 }), 'Removed 1 tracking parameter.');
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('Failed:\n  - ' + failures.join('\n  - ')); process.exit(1); }
