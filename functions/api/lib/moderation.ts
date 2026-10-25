/**
 * Content rules: no obscene language in text, no adult (18+) or graphically violent pictures and videos.
 *
 *   profanityIn      local word list (Russian, Ukrainian, English, transliterated mat); nothing leaves the server
 *   moderateImages   one or several pictures (a video is judged by a few frames the browser took from it).
 *                    OpenAI's moderation endpoint when OPENAI_API_KEY is set (free, built for this), otherwise the
 *                    Workers AI vision model. A provider that is down never blocks anybody: the picture is let through and logged.
 *   MODERATION_OFF=1 switches every check off (local development, tests).
 */
import type { Env } from '../../../types';

export const modOff = (env: Env): boolean => env.MODERATION_OFF === '1';

// ───────────────────────── obscene language ─────────────────────────

const LOOKALIKE: Record<string, string> = { a: 'а', b: 'в', c: 'с', e: 'е', h: 'н', i: 'и', k: 'к', m: 'м', o: 'о', p: 'р', t: 'т', x: 'х', y: 'у', '3': 'з', '0': 'о', '6': 'б', '@': 'а' };
const HAS_CYR = /[а-яёєіїґ]/;
const STEM = '(?:вы|за|на|по|до|у|от|об|раз|рас|пере|при|про|под|не|ни|недо|съ|объ|подъ|разъ|вс|во)?';

const RU = [
  new RegExp(`^${STEM}ху[йяюеи]`),                                  // хуй, хуя, хуе…, хуи…, нахуй
  /пизд/,
  new RegExp(`^${STEM}еб(?:а|у|и|ы|л|н|о|т|ш|ем|ет)`),               // ебать, ебу, ебло, заебись, выебал (не: небо, себя, хлеб)
  /^еб$/,
  /^(?:мудо|долбо|дауно|довбо)?[её]б/,
  /^(?:довбо|долбо)?йоб/,
  /^бля$|^бляд|^блят|^блять/,
  /^сук(?:а|и|е|у|ой)$|^суч(?:ар|к[аиу])/,
  /^муд(?:ак|ач|ил|озвон)/,
  /^пид[оа]р|^педик/,
  /^залуп/, /^г[ао]ндон/, /^шлюх/, /^шалав/, /^ублюд/,
  /^манд(?:а|е|у|ой|ы)$/, /^дроч(?:и|ь|ен|ер|ун)/, /^курв(?:а|ы|е|у|ой)$/,
];

const EN = [
  /fuck/, /shit/, /bitch/, /^cunt/, /^asshole/, /motherf/, /^whore/, /^slut/, /^nigg(?:er|a)/, /^fagg?ot/, /^twat/, /^dickhead/, /^wank(?:er|ers|ing)?$/,
  /^pizd/, /^bly(?:a|ad|at)/, /^suka$/, /^pidor/, /^pidar/, /^mudak/, /^zalup/, /^gandon/, /^ebat/, /^ebal/, /^ebany/, /^(?:na|po)hu[iy]/, /^huesos/, /^huynya/,
];
const MASKED = /f[*@#x]{1,2}ck|sh[*@#1!]t(?![a-z])|b[*@#]tch|п[*@#]зд|х[*@#]й|бл[*@#]ть|еб[*@#]ть/u;

function cleanWords(text: string, join: boolean): string[] {
  let t = text.normalize('NFKC').toLowerCase().replace(/[​-‏⁠﻿­]/g, '');
  t = t.replace(/ё|є|ї/g, 'е').replace(/і/g, 'и').replace(/ґ/g, 'г').replace(/ь/g, '');
  if (join) {
    t = t.replace(/(?<=\p{L})[._*\-·•](?=\p{L})/gu, '');                                // х.у.й  х-у-й
    t = t.replace(/(?<![\p{L}\p{N}])(\p{L})(?:\s+\p{L}(?![\p{L}\p{N}]))+/gu, (m) => m.replace(/\s+/g, ''));   // х у й
  }
  return (t.match(/[\p{L}\p{N}@]+/gu) ?? []).map((w) => (HAS_CYR.test(w) ? w.replace(/[abcehikmopxy360@]/g, (c) => LOOKALIKE[c]) : w));
}

/** True when the text contains obscene language. The words are never returned: the message only says "remove it". */
export function profanityIn(text: string): boolean {
  if (!text) return false;
  if (MASKED.test(text.toLowerCase())) return true;
  for (const join of [false, true]) {
    for (const w of cleanWords(text, join)) {
      if (HAS_CYR.test(w) ? RU.some((r) => r.test(w)) : EN.some((r) => r.test(w))) return true;
    }
  }
  return false;
}

export const PROFANITY_MESSAGE = 'The text contains obscene language, which Vane does not publish. Remove it and try again.';

/** The message to show when any of the texts is not allowed, otherwise null. */
export const textProblem = (env: Env, ...texts: (string | null | undefined)[]): string | null =>
  !modOff(env) && texts.some((t) => t && profanityIn(t)) ? PROFANITY_MESSAGE : null;

// ───────────────────────── adult and violent pictures ─────────────────────────

export interface Picture { bytes: Uint8Array; mime: string }
export type MediaVerdict = { ok: true; checked: boolean } | { ok: false; reason: 'sexual' | 'violence' };

export const mediaMessage = (reason: 'sexual' | 'violence', video = false): string =>
  `This ${video ? 'video' : 'image'} looks like ${reason === 'sexual' ? 'adult (18+) content' : 'graphic violence'}, which Vane does not publish.`;

const b64 = (bytes: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

async function viaOpenAI(key: string, pics: Picture[]): Promise<MediaVerdict> {
  const res = await fetch('https://api.openai.com/v1/moderations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'omni-moderation-latest', input: pics.map((p) => ({ type: 'image_url', image_url: { url: `data:${p.mime};base64,${b64(p.bytes)}` } })) }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`openai moderation ${res.status}`);
  const data = (await res.json()) as { results?: { categories?: Record<string, boolean>; category_scores?: Record<string, number> }[] };
  const results = data.results ?? [];
  if (!results.length) throw new Error('openai moderation: empty answer');
  for (const r of results) {
    const c = r.categories ?? {}, s = r.category_scores ?? {};
    if (c.sexual || (s.sexual ?? 0) >= 0.5) return { ok: false, reason: 'sexual' };
    if (c['violence/graphic'] || (s['violence/graphic'] ?? 0) >= 0.5 || (s.violence ?? 0) >= 0.9) return { ok: false, reason: 'violence' };
  }
  return { ok: true, checked: true };
}

const VISION = '@cf/meta/llama-3.2-11b-vision-instruct';
const ASK = 'You are a content-safety classifier. Look at the image. Answer with one JSON object and nothing else: {"sexual": true or false, "violence": true or false}. "sexual" is true for nudity, pornography or explicit sexual content. "violence" is true for graphic violence: gore, open wounds, blood, dead bodies, torture, executions. Ordinary sports, cartoons and medical diagrams are false.';

async function visionOnce(ai: NonNullable<Env['AI']>, p: Picture): Promise<MediaVerdict> {
  const run = () => ai.run(VISION, { messages: [{ role: 'system', content: ASK }, { role: 'user', content: 'Classify this image.' }], image: `data:${p.mime};base64,${b64(p.bytes)}`, max_tokens: 40 });
  let out: unknown;
  try {
    out = await run();
  } catch (err) {
    if (!/agree|licen/i.test(err instanceof Error ? err.message : '')) throw err;
    await ai.run(VISION, { prompt: 'agree' });                               // the model's licence is accepted once per account
    out = await run();
  }
  const text = typeof (out as { response?: unknown })?.response === 'string' ? (out as { response: string }).response : '';
  const json = /\{[^{}]*\}/.exec(text)?.[0];
  if (!json) throw new Error('vision model gave no verdict');
  const v = JSON.parse(json) as { sexual?: unknown; violence?: unknown };
  if (v.sexual === true) return { ok: false, reason: 'sexual' };
  if (v.violence === true) return { ok: false, reason: 'violence' };
  return { ok: true, checked: true };
}

/** Checks the pictures (a video: its frames). Provider trouble lets the picture through, because a person must not be blocked by our outage. */
export async function moderateImages(env: Env, pics: Picture[]): Promise<MediaVerdict> {
  if (modOff(env) || !pics.length) return { ok: true, checked: false };
  try {
    if (env.OPENAI_API_KEY) return await viaOpenAI(env.OPENAI_API_KEY, pics);
    if (env.AI) {
      for (const p of pics) {
        const v = await visionOnce(env.AI, p);
        if (!v.ok) return v;
      }
      return { ok: true, checked: true };
    }
  } catch (err) {
    console.error('media moderation failed', err instanceof Error ? err.message : 'unknown');
  }
  return { ok: true, checked: false };
}
