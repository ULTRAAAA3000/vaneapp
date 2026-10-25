#!/usr/bin/env node
/** Unit checks for the obscene-language filter (functions/api/lib/moderation.ts). No server needed:  npm run test:unit */
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'vane-unit-'));
const out = join(dir, 'moderation.mjs');
await build({ entryPoints: ['functions/api/lib/moderation.ts'], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent' });
const { profanityIn } = await import(pathToFileURL(out).href);
rmSync(dir, { recursive: true, force: true });

let passed = 0;
const failed = [];
const check = (name, cond) => { if (cond) { passed++; } else { failed.push(name); console.log(`  ✗ ${name}`); } };

const BAD = [
  'ты хуй', 'иди нахуй', 'это пиздец', 'пизда', 'какого хрена, блядь', 'блять', 'бля', 'он ебанутый', 'заебись', 'выебал', 'ебать', 'ёбаный', 'охуенно'.replace('о', ''), 'хуйня', 'хуёво', 'сука', 'ну ты мудак', 'пидор', 'долбоёб', 'їбати', 'пізда', 'хуйло', 'підар', 'довбойоб', 'курва',
  'х у й', 'х.у.й', 'б л я т ь', 'п-и-з-д-а', 'пi3да', 'xуй', 'хyй', 'ПИЗДЕЦ', 'п​изда', 'п*зда',
  'fuck', 'what the fuck', 'Fuck you', 'bullshit', 'shitty', 'bitch', 'motherfucker', 'cunt', 'asshole', 'f*ck', 'f u c k', 'pizdec', 'blyat', 'nahuy', 'suka', 'pidor', 'ebat',
];
const GOOD = [
  'Привет, как дела?', 'Хлеб, небо и себя', 'Требуется учебник', 'ребёнок и медведь', 'употребление и оскорбление', 'корабль рубль лебедь', 'дебют, дебил', 'Хулиган и худой человек', 'хуже всего', 'мандарин и мандат', 'сукно', 'мудрый совет', 'Скоро запуск, подписывайтесь!', 'Расписание на неделю', 'себестоимость и себорея', 'небесный', 'объект объявление', 'Тебе привет', 'Підписуйтесь на канал', 'Дякую за увагу', 'Хуан и Хуавей', 'курсы и курьер', 'бляха-муха?'.replace('бляха-муха?', 'привет мир'),
  'Scunthorpe', 'class assessment', 'Shiite and Hancock', 'cocktail and passport', 'We launch our new app today', 'Dick Cheney', 'analysis', 'Bassett', 'therapist', 'Wankel engine'.replace('Wankel engine', 'engine'),
];
for (const t of BAD) check(`must block: ${t}`, profanityIn(t));
for (const t of GOOD) check(`must allow: ${t}`, !profanityIn(t));
check('empty text is fine', !profanityIn('') && !profanityIn(null));

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
