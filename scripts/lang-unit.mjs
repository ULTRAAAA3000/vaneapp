#!/usr/bin/env node
/**
 * The site translations: Russian (assets/lang-ru.js) and Ukrainian (assets/lang-uk.js), one engine (assets/lang.js).
 * The two dictionaries are mirrors of each other, so a phrase added to one must be added to the other; this keeps them in step and the
 * Ukrainian clean. It reads the files only, no browser.   npm run test:unit
 */
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';

let passed = 0;
const failed = [];
const check = (name, cond, extra = '') => { if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed.push(name); console.log(`  ✗ ${name} ${extra}`); } };
const dictOf = (file, name) => { const w = {}; vm.runInNewContext(readFileSync(file, 'utf8'), { window: w }); return w[name]; };
const ru = dictOf('public/assets/lang-ru.js', 'VANE_RU');
const uk = dictOf('public/assets/lang-uk.js', 'VANE_UK');
const CYR = /[А-Яа-яІіЇїЄєҐґ]/;
const digits = (s) => (s.replace(/(?<=\d)[ ,.\u00a0](?=\d{3}\b)/g, '').match(/\d+/g) || []).sort().join();
const latin = (s) => [...new Set((s.match(/[A-Za-z][A-Za-z0-9._/@:#+-]*/g) || []).map((t) => t.replace(/^[.:;,-]+|[.:;,-]+$/g, '')))].sort().join();
const bad = (fn) => Object.keys(uk).filter((k) => fn(k, uk[k], ru[k]));
const show = (list) => JSON.stringify(list.slice(0, 3)).slice(0, 240);

console.log('\nThe two dictionaries are mirrors');
check('both load and are not empty', Object.keys(ru).length > 1000 && Object.keys(uk).length > 1000);
check('exactly the same phrases, in the same order', JSON.stringify(Object.keys(ru)) === JSON.stringify(Object.keys(uk)), `RU ${Object.keys(ru).length}, UK ${Object.keys(uk).length}; only in RU: ${show(Object.keys(ru).filter((k) => !(k in uk)))}; only in UK: ${show(Object.keys(uk).filter((k) => !(k in ru)))}`);
check('every value is a non-empty string', bad((k, v) => typeof v !== 'string' || !v.trim()).length === 0);
check('a phrase the Russian version leaves as it is (a name, a code) stays as it is here', bad((k, v, r) => r === k && v !== k).length === 0, show(bad((k, v, r) => r === k && v !== k)));
check('a phrase the Russian version writes in Cyrillic is in Cyrillic here too', bad((k, v, r) => CYR.test(r) && !CYR.test(v)).length === 0, show(bad((k, v, r) => CYR.test(r) && !CYR.test(v))));

console.log('\nThe Ukrainian is clean');
check('no letters that Ukrainian does not have (ы э ъ ё)', bad((k, v) => /[ыэъёЫЭЪЁ]/.test(v)).length === 0, show(bad((k, v) => /[ыэъёЫЭЪЁ]/.test(v))));
const RU_WORDS = /(?<![А-Яа-яІіЇїЄєҐґ])(и|что|это|или|как|мы|вы|будет|можно|нужно|если|только|тоже|нет|когда|ещё|который|которые)(?![А-Яа-яІіЇїЄєҐґ])/i;
check('no Russian words (и, что, это, или, как, мы, вы, можно, если…)', bad((k, v) => RU_WORDS.test(v)).length === 0, show(bad((k, v) => RU_WORDS.test(v))));
check('the apostrophe is the typographic one (з’явиться), never a straight quote inside a word', bad((k, v) => /[А-Яа-яІіЇїЄєҐґ]['ʼ`][А-Яа-яІіЇїЄєҐґ]/.test(v)).length === 0, show(bad((k, v) => /[А-Яа-яІіЇїЄєҐґ]['ʼ`][А-Яа-яІіЇїЄєҐґ]/.test(v))));
check('every number is the one in the Russian version (prices, limits, times)', bad((k, v, r) => digits(v) !== digits(r)).length === 0, show(bad((k, v, r) => digits(v) !== digits(r))));
check('every name, address and code keeps its Latin spelling as in the Russian version', bad((k, v, r) => latin(v) !== latin(r)).length === 0, show(bad((k, v, r) => latin(v) !== latin(r)).map((k) => [k.slice(0, 50), latin(ru[k]), latin(uk[k])])));
check('the product words are the Ukrainian ones: допис, а не «пост»', bad((k, v) => /(?<![А-Яа-яІіЇїЄєҐґ])пост(и|ів|у|ом|ах)?(?![А-Яа-яІіЇїЄєҐґ])/i.test(v)).length === 0, show(bad((k, v) => /(?<![А-Яа-яІіЇїЄєҐґ])пост(и|ів|у|ом|ах)?(?![А-Яа-яІіЇїЄєҐґ])/i.test(v))));

console.log('\nThe phrases with numbers and names (assets/lang.js)');
{
  const src = readFileSync('public/assets/lang.js', 'utf8');
  const part = src.slice(src.indexOf('var LANGS = {'), src.indexOf('var dicts = {};'));
  const DICT = { 'Tomorrow · 09:00': 'Завтра · 09:00' };
  const LANGS = new Function('DICT', `${part}; return LANGS;`)(DICT);
  const t = (code, text) => { for (const [re, fn] of LANGS[code].patterns) { const m = re.exec(text); if (m) return fn(m); } return null; };
  check('Ukrainian and Russian have the same number of phrases', LANGS.uk.patterns.length === LANGS.ru.patterns.length && LANGS.uk.patterns.length === 8);
  check('Ukrainian: "12 characters" → "12 символів"', t('uk', '12 characters') === '12 символів');
  check('Ukrainian: "Queued for … on 3 networks" uses the dictionary for the time', t('uk', 'Queued for Tomorrow · 09:00 on 3 networks') === 'У черзі: Завтра · 09:00, мереж: 3', t('uk', 'Queued for Tomorrow · 09:00 on 3 networks'));
  check('Ukrainian: the video demo lines', t('uk', '» fast-forwarding to 09:00:00 …') === '» перемотуємо до 09:00:00 …' && t('uk', 'delivered at 09:00:00 · 420 ms') === 'доставлено о 09:00:00 · 420 мс' && t('uk', '2 / 3 uploads') === '2 / 3 завантажень');
  check('Ukrainian: the calculator line', t('uk', 'At this setup per-channel pricing is cheaper. Vane wins from 12 channels up.') === 'За таких даних оплата за канал дешевша. Vane виграє від 12 каналів.');
  check('Ukrainian: "12.4K views · 3 weeks ago", with and without "Your Channel"', t('uk', 'Your Channel · 12.4K views · 3 weeks ago') === 'Ваш канал · 12.4K переглядів · 3 тиж. тому' && t('uk', '9K views · 1 day ago') === '9K переглядів · 1 дн. тому' && t('uk', 'Your Channel · 0 views · Just now') === 'Ваш канал · 0 переглядів · щойно');
  check('Russian still says the same as before', t('ru', '12 characters') === '12 символов' && t('ru', 'Your Channel · 12.4K views · 3 weeks ago') === 'Ваш канал · 12.4K просмотров · 3 нед. назад' && t('ru', 'Queued for Tomorrow · 09:00 on 3 networks') === 'В очереди: Завтра · 09:00, сетей: 3');
  check('an unknown phrase is left alone', t('uk', 'Something else') === null);
}

console.log('\nEvery page that has the switch');
{
  const pages = [...readdirSync('public').filter((f) => f.endsWith('.html')), ...readdirSync('public/networks').map((f) => `networks/${f}`)]
    .filter((f) => readFileSync(`public/${f}`, 'utf8').includes('assets/lang.js'));
  const html = (f) => readFileSync(`public/${f}`, 'utf8');
  check('there are pages with the switch', pages.length >= 20, String(pages.length));
  check('each one has the three buttons: English, Українська, Русский (in that order)', pages.every((f) => /data-lang="en"[\s\S]*?>English<[\s\S]*?data-lang="uk"[\s\S]*?>Українська<[\s\S]*?data-lang="ru"[\s\S]*?>Русский</.test(html(f))), pages.filter((f) => !/data-lang="uk"/.test(html(f))).join(', '));
  check('each one tells lang.js where both dictionaries are', pages.every((f) => /data-dict="\/assets\/lang-ru\.js\?v=[0-9a-f]+"/.test(html(f)) && /data-dict-uk="\/assets\/lang-uk\.js\?v=[0-9a-f]+"/.test(html(f))), pages.filter((f) => !/data-dict-uk=/.test(html(f))).join(', '));
}

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
