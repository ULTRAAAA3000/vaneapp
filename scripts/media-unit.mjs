#!/usr/bin/env node
/** Unit checks for the picture and video check (functions/api/lib/moderation.ts, videoframes.ts). No server, no network:  npm run test:unit */
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'vane-unit-'));
const load = async (entry, name) => {
  const out = join(dir, `${name}.mjs`);
  await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent' });
  return import(pathToFileURL(out).href);
};
const mod = await load('functions/api/lib/moderation.ts', 'moderation');
const frames = await load('functions/api/lib/videoframes.ts', 'videoframes');
rmSync(dir, { recursive: true, force: true });

let passed = 0;
const failed = [];
const check = (name, cond) => { if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed.push(name); console.log(`  ✗ ${name}`); } };
const quiet = console.error;
console.error = () => {};                         // the checker logs every provider failure on purpose

const pic = (n) => ({ bytes: new Uint8Array([0xff, 0xd8, 0xff, n]), mime: 'image/jpeg' });
const url = (p) => `data:${p.mime};base64,${Buffer.from(p.bytes).toString('base64')}`;
/** A fake Workers AI: `answer(question kind, image)` gives the text, or throws. Counts the calls. */
const fakeAI = (answer) => {
  const ai = { calls: 0, run: async (_model, input) => {
    ai.calls++;
    const q = input.messages?.[1]?.content ?? '';
    return { response: answer(/nudity/.test(q) ? 'sexual' : 'violence', input.image, ai.calls) };
  } };
  return ai;
};

console.log('\nreading the model\'s answer');
check('YES / yes / "Yes, ..." are yes', ['YES', 'yes', 'Yes, it does.', ' YES.'].every((t) => mod.parseYesNo(t) === true));
check('NO / no / "No, ..." are no', ['NO', 'no', 'No, it does not.', 'No.'].every((t) => mod.parseYesNo(t) === false));
check('a refusal counts as YES (the model reacts to what it sees)', ["I can't help with that.", "I'm sorry, but I cannot assist with this request.", 'This image is too explicit to describe.'].every((t) => mod.parseYesNo(t) === true));
check('an answer with nothing usable is null', mod.parseYesNo('') === null && mod.parseYesNo('hmm, blue sky') === null);

console.log('\nWorkers AI as the judge');
const clean = fakeAI(() => 'NO');
check('clean frames pass and are marked checked', JSON.stringify(await mod.moderateImages({ AI: clean }, [pic(1), pic(2), pic(3)])) === '{"ok":true,"checked":true}');
check('every frame is asked both questions', clean.calls === 6);
check('nudity is refused as sexual', (await mod.moderateImages({ AI: fakeAI((k) => (k === 'sexual' ? 'YES' : 'NO')) }, [pic(1)])).reason === 'sexual');
check('gore is refused as violence', (await mod.moderateImages({ AI: fakeAI((k) => (k === 'violence' ? 'YES' : 'NO')) }, [pic(1)])).reason === 'violence');
check('a refusing model refuses the picture', (await mod.moderateImages({ AI: fakeAI(() => "I'm sorry, I can't help with that.") }, [pic(1)])).reason === 'sexual');
const last = pic(8);
const oneBad = await mod.moderateImages({ AI: fakeAI((k, img) => (k === 'sexual' && img === url(last) ? 'YES' : 'NO')) }, [1, 2, 3, 4, 5, 6, 7].map(pic).concat(last));
check('ONE flagged frame out of 8 refuses the whole video', !oneBad.ok && oneBad.reason === 'sexual');
const flaky = new Map();
const hiccup = await mod.moderateImages({ AI: fakeAI((k, img) => { const key = k + img; flaky.set(key, (flaky.get(key) ?? 0) + 1); if (flaky.get(key) === 1) throw new Error('capacity'); return 'NO'; }) }, [pic(1), pic(2)]);
check('a provider hiccup is retried and the real answer is used', hiccup.ok && hiccup.checked === true);

console.log('\nfailing CLOSED');
const down = await mod.moderateImages({ AI: fakeAI(() => { throw new Error('down'); }) }, [pic(1)]);
check('a provider that is down refuses with "unchecked", never lets the file through', !down.ok && down.reason === 'unchecked');
const garbage = await mod.moderateImages({ AI: fakeAI(() => 'hmm, blue sky') }, [pic(1)]);
check('an unreadable answer refuses with "unchecked"', !garbage.ok && garbage.reason === 'unchecked');
const none = await mod.moderateImages({}, [pic(1)]);
check('no provider configured refuses with "unchecked"', !none.ok && none.reason === 'unchecked');
const empty = await mod.moderateImages({ AI: clean }, []);
check('nothing to look at is not "fine"', !empty.ok && empty.reason === 'unchecked');
const mixed = await mod.moderateImages({ AI: fakeAI((k, img) => { if (img === url(pic(1))) return k === 'sexual' ? 'YES' : 'NO'; throw new Error('down'); }) }, [pic(1), pic(2)]);
check('a flagged frame wins over a frame that could not be judged', !mixed.ok && mixed.reason === 'sexual');
check('MODERATION_OFF=1 switches it off (local development)', (await mod.moderateImages({ MODERATION_OFF: '1' }, [pic(1)])).ok === true);

console.log('\nOpenAI as the judge');
const realFetch = globalThis.fetch;
const sent = [];
const openai = (result, status = 200) => { globalThis.fetch = async (_u, init) => { sent.push(JSON.parse(init.body)); return new Response(JSON.stringify({ results: [result] }), { status }); }; };
const KEY = { OPENAI_API_KEY: 'sk-test' };
openai({ categories: {}, category_scores: { sexual: 0.05, violence: 0.01 } });
check('low scores pass', (await mod.moderateImages(KEY, [pic(1)])).ok === true);
openai({ categories: {}, category_scores: { sexual: 0.4 } });
check('a sexual score of 0.4 is refused (the old line was 0.5)', (await mod.moderateImages(KEY, [pic(1)])).reason === 'sexual');
openai({ categories: { 'sexual/minors': true }, category_scores: {} });
check('the sexual/minors flag is refused', (await mod.moderateImages(KEY, [pic(1)])).reason === 'sexual');
openai({ categories: {}, category_scores: { 'violence/graphic': 0.45 } });
check('graphic violence from 0.4 is refused', (await mod.moderateImages(KEY, [pic(1)])).reason === 'violence');
sent.length = 0;
openai({ categories: {}, category_scores: {} });
await mod.moderateImages(KEY, [pic(1), pic(2), pic(3)]);
check('one request per frame, one picture in each (frames never dilute each other)', sent.length === 3 && sent.every((b) => b.input.length === 1));
openai({}, 500);
const noFallback = await mod.moderateImages(KEY, [pic(1)]);
check('OpenAI down and no other judge refuses with "unchecked"', !noFallback.ok && noFallback.reason === 'unchecked');
const viaFallback = await mod.moderateImages({ ...KEY, AI: fakeAI(() => 'NO') }, [pic(1)]);
check('OpenAI down: Workers AI answers instead', viaFallback.ok && viaFallback.checked === true);
const fallbackFlags = await mod.moderateImages({ ...KEY, AI: fakeAI((k) => (k === 'sexual' ? 'YES' : 'NO')) }, [pic(1)]);
check('OpenAI down: Workers AI can still refuse', !fallbackFlags.ok && fallbackFlags.reason === 'sexual');
globalThis.fetch = realFetch;

console.log('\nmessages and codes');
check('unchecked is a 503 with its own code, flagged files are 422', mod.mediaStatus('unchecked') === 503 && mod.mediaStatus('sexual') === 422 && mod.mediaCode('unchecked') === 'media_unchecked' && mod.mediaCode('sexual') === 'media_adult' && mod.mediaCode('violence') === 'media_violence');
check('the "unchecked" text asks to try again', /try again/i.test(mod.mediaMessage('unchecked', true)));

console.log('\nhow many frames a video needs');
check('unknown or tiny length asks for the minimum (3)', [null, 0, NaN, 2, 10, 18].every((s) => frames.framesNeeded(s) === 3));
check('one frame every ~6 seconds', frames.framesNeeded(30) === 5 && frames.framesNeeded(42) === 7);
check('never more than 8', frames.framesNeeded(600) === 8 && frames.framesNeeded(99999) === 8);

const box = (type, ...parts) => { const body = Buffer.concat(parts); const h = Buffer.alloc(8); h.writeUInt32BE(8 + body.length, 0); h.write(type, 4, 'latin1'); return Buffer.concat([h, body]); };
const mvhd0 = (scale, dur) => { const b = Buffer.alloc(100); b.writeUInt32BE(scale, 12); b.writeUInt32BE(dur, 16); return box('mvhd', b); };
const mvhd1 = (scale, dur) => { const b = Buffer.alloc(112); b[0] = 1; b.writeUInt32BE(scale, 20); b.writeUInt32BE(Math.floor(dur / 2 ** 32), 24); b.writeUInt32BE(dur % 2 ** 32, 28); return box('mvhd', b); };
const mp4 = (mvhd) => new Uint8Array(Buffer.concat([box('ftyp', Buffer.from('isom0000', 'latin1')), box('mdat', Buffer.alloc(16)), box('moov', mvhd)]));
check('the length is read from mvhd (version 0, moov after mdat)', frames.videoSeconds(mp4(mvhd0(1000, 30000))) === 30);
check('the length is read from mvhd (version 1)', frames.videoSeconds(mp4(mvhd1(90000, 90000 * 45))) === 45);
check('a file without moov has no length', frames.videoSeconds(new Uint8Array(Buffer.concat([box('ftyp', Buffer.from('isom0000')), box('mdat', Buffer.alloc(8))]))) === null);
check('garbage has no length and does not throw', frames.videoSeconds(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])) === null);

console.error = quiet;
console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
