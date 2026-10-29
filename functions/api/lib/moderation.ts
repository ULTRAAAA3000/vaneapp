/**
 * Content rules: no obscene language in text, no adult (18+) or graphically violent pictures and videos.
 *
 *   profanityIn      local word list (Russian, Ukrainian, English, transliterated mat); nothing leaves the server
 *   moderateImages   one or several pictures (a video is judged by frames the browser took from it). Every picture is judged on its
 *                    own: OpenAI's moderation endpoint when OPENAI_API_KEY is set (free, built for this), Workers AI vision
 *                    as the fallback (and the main judge when there is no key). One flagged picture refuses the whole file.
 *                    It fails CLOSED: when no provider can give an answer (down, unreadable reply, nothing configured) the
 *                    file is refused with reason 'unchecked' (the person retries), never let through unseen.
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
/** 'unchecked' = WE could not judge it (provider trouble); the file is refused, and the person can simply try again. */
export type MediaReason = 'sexual' | 'violence' | 'unchecked';
export type MediaVerdict = { ok: true; checked: boolean } | { ok: false; reason: MediaReason };

export const mediaMessage = (reason: MediaReason, video = false): string => {
  const what = video ? 'video' : 'image';
  return reason === 'unchecked'
    ? `We could not check this ${what} for 18+ or violent content just now, so it was not accepted. Please try again in a minute.`
    : `This ${what} looks like ${reason === 'sexual' ? 'adult (18+) content' : 'graphic violence'}, which Vane does not publish.`;
};
export const mediaCode = (reason: MediaReason): string => (reason === 'sexual' ? 'media_adult' : reason === 'violence' ? 'media_violence' : 'media_unchecked');
/** 422 when the picture itself is refused, 503 when we could not judge it. */
export const mediaStatus = (reason: MediaReason): 422 | 503 => (reason === 'unchecked' ? 503 : 422);

/**
 * Scores at or above these refuse the picture. Deliberately low: a wrongly refused picture costs one retry, a wrongly published
 * one costs the account. OpenAI's own yes/no flags are honoured as well.
 */
export const SEXUAL_AT = 0.35;
export const SEXUAL_MINORS_AT = 0.05;
export const VIOLENCE_GRAPHIC_AT = 0.4;
export const VIOLENCE_AT = 0.8;

/** Pictures judged at the same time (a video has up to 8 frames; the vision model is not asked 16 times at once). */
const PARALLEL = 4;
const TRIES = 3;
const PAUSE_MS = 250;

type Flag = 'sexual' | 'violence' | null;

const b64 = (bytes: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const dataUrl = (p: Picture): string => `data:${p.mime};base64,${b64(p.bytes)}`;

/** Tries again after a short, growing pause: one hiccup of a provider must not decide the verdict. */
async function retried<T>(run: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let i = 0; i < TRIES; i++) {
    try { return await run(); } catch (err) {
      last = err;
      if (i < TRIES - 1) await new Promise<void>((r) => setTimeout(r, PAUSE_MS * (i + 1)));
    }
  }
  throw last;
}

// ── OpenAI: one request per picture, so frames never dilute each other

async function viaOpenAI(key: string, pic: Picture): Promise<Flag> {
  const res = await fetch('https://api.openai.com/v1/moderations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'omni-moderation-latest', input: [{ type: 'image_url', image_url: { url: dataUrl(pic) } }] }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`openai moderation ${res.status}`);
  const data = (await res.json()) as { results?: { categories?: Record<string, boolean>; category_scores?: Record<string, number> }[] };
  const r = data.results?.[0];
  if (!r) throw new Error('openai moderation: empty answer');
  const c = r.categories ?? {}, s = r.category_scores ?? {};
  if (c.sexual || c['sexual/minors'] || (s.sexual ?? 0) >= SEXUAL_AT || (s['sexual/minors'] ?? 0) >= SEXUAL_MINORS_AT) return 'sexual';
  if (c['violence/graphic'] || (s['violence/graphic'] ?? 0) >= VIOLENCE_GRAPHIC_AT || (s.violence ?? 0) >= VIOLENCE_AT) return 'violence';
  return null;
}

// ── Workers AI vision: two narrow YES/NO questions per picture, temperature 0

const VISION = '@cf/meta/llama-3.2-11b-vision-instruct';
const JUDGE = 'You are an automated content-safety filter for a social network. You are shown one image and one question about it. Answer with exactly one word: YES or NO. Never explain.';
const SEXUAL_Q = 'Does this image contain nudity or sexual content? Answer YES if ANY of this is visible: exposed genitals, exposed female nipples or areolae (topless), bare buttocks, see-through clothing that shows them, a sex act or sexual touching, pornography, or lingerie/underwear shown in an erotic pose. Answer NO for ordinary clothed people, swimwear on a beach or pool, sport, a bare male chest, babies in a bath, medical or art-history images with no explicit nudity. Answer YES or NO.';
const VIOLENCE_Q = 'Does this image show graphic violence? Answer YES if ANY of this is visible: gore, open wounds, a lot of blood, mutilation, dead bodies, torture, an execution, a person being seriously hurt. Answer NO for sport, cartoons, toy or movie-prop weapons, kitchen scenes, or a small plaster-sized cut. Answer YES or NO.';

/** A model that REFUSES to talk about a picture is reacting to what is in it: that counts as YES. */
const REFUSAL = /\b(can(?:'|’)?t|cannot|can not|unable|not able|won(?:'|’)?t|sorry|i(?:'|’)m not comfortable|inappropriate|explicit)\b/i;

/** true = YES, false = NO, null = no usable answer. */
export function parseYesNo(text: string): boolean | null {
  const t = text.trim();
  const lead = /^\W*(yes|no)\b/i.exec(t);
  if (lead) return lead[1].toLowerCase() === 'yes';
  if (REFUSAL.test(t)) return true;
  const yes = /\byes\b/i.test(t), no = /\bno\b/i.test(t);
  if (yes !== no) return yes;
  return null;
}

async function askVision(ai: NonNullable<Env['AI']>, pic: Picture, question: string): Promise<boolean> {
  const run = () => ai.run(VISION, { messages: [{ role: 'system', content: JUDGE }, { role: 'user', content: question }], image: dataUrl(pic), max_tokens: 8, temperature: 0 });
  let out: unknown;
  try {
    out = await run();
  } catch (err) {
    if (!/agree|licen/i.test(err instanceof Error ? err.message : '')) throw err;
    await ai.run(VISION, { prompt: 'agree' });                               // the model's licence is accepted once per account
    out = await run();
  }
  const text = typeof (out as { response?: unknown })?.response === 'string' ? (out as { response: string }).response : '';
  const answer = parseYesNo(text);
  if (answer === null) throw new Error('vision model gave no verdict');   // retried, and if it keeps happening the picture is refused as unchecked
  return answer;
}

async function viaVision(ai: NonNullable<Env['AI']>, pic: Picture): Promise<Flag> {
  const [sexual, violence] = await Promise.all([askVision(ai, pic, SEXUAL_Q), askVision(ai, pic, VIOLENCE_Q)]);
  return sexual ? 'sexual' : violence ? 'violence' : null;
}

// ── putting it together

/** One picture: OpenAI first when there is a key, Workers AI when OpenAI is down (or there is no key). Throws when nobody could answer. */
async function judge(env: Env, pic: Picture): Promise<Flag> {
  let last: unknown = new Error('no moderation provider is configured');
  if (env.OPENAI_API_KEY) {
    const key = env.OPENAI_API_KEY;
    try { return await retried(() => viaOpenAI(key, pic)); } catch (err) { last = err; }
  }
  if (env.AI) {
    const ai = env.AI;
    try { return await retried(() => viaVision(ai, pic)); } catch (err) { last = err; }
  }
  throw last;
}

/**
 * Checks the pictures (a video: its frames). ONE flagged picture refuses everything. Fails closed: if any picture could not be
 * judged (and none of the others was flagged) the answer is 'unchecked', never "fine".
 */
export async function moderateImages(env: Env, pics: Picture[]): Promise<MediaVerdict> {
  if (modOff(env)) return { ok: true, checked: false };
  if (!pics.length) return { ok: false, reason: 'unchecked' };
  const flags: Flag[] = [];
  let failed = false;
  for (let i = 0; i < pics.length; i += PARALLEL) {
    const batch = await Promise.allSettled(pics.slice(i, i + PARALLEL).map((p) => judge(env, p)));
    for (const r of batch) {
      if (r.status === 'fulfilled') flags.push(r.value);
      else {
        failed = true;
        console.error('media moderation failed', r.reason instanceof Error ? r.reason.message : 'unknown');
      }
    }
    if (flags.includes('sexual')) break;                                    // nothing can change a refusal: stop spending calls
  }
  if (flags.includes('sexual')) return { ok: false, reason: 'sexual' };
  if (flags.includes('violence')) return { ok: false, reason: 'violence' };
  return failed ? { ok: false, reason: 'unchecked' } : { ok: true, checked: true };
}
