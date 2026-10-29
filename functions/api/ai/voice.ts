import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { requireUser } from '../lib/auth';
import { loadVoice, recentOwnPosts, saveVoice, VOICE_NOTES_MAX, VOICE_SAMPLE_MAX, VOICE_SAMPLES } from '../lib/aiplus';
import { failCode, isRecord, json, methodNotAllowed, readJson } from '../lib/http';

const limits = { notesMax: VOICE_NOTES_MAX, sampleMax: VOICE_SAMPLE_MAX, samplesMax: VOICE_SAMPLES };

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  const voice = await loadVoice(env, auth.userId);
  const own = voice.samples.length ? 0 : (await recentOwnPosts(env, auth.userId, VOICE_SAMPLES)).length;
  return json({ ok: true, ...voice, learnedFromPosts: own >= 2 ? own : 0, limits });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  const parsed = await readJson(request, 8192);
  if (!parsed.ok) return parsed.response;
  const b = parsed.data;
  if (!isRecord(b)) return failCode(400, 'invalid_body', 'Body must be a JSON object.');
  const cur = await loadVoice(env, auth.userId);
  let description = cur.description;
  let samples = cur.samples;
  let enabled = cur.enabled;
  if (b.description !== undefined) {
    if (typeof b.description !== 'string' || b.description.length > VOICE_NOTES_MAX) return failCode(400, 'invalid_description', `Describe your style in at most ${VOICE_NOTES_MAX} characters.`);
    description = b.description.trim();
  }
  if (b.samples !== undefined) {
    if (!Array.isArray(b.samples) || b.samples.length > VOICE_SAMPLES || !b.samples.every((x) => typeof x === 'string' && x.length <= VOICE_SAMPLE_MAX)) {
      return failCode(400, 'invalid_samples', `Add up to ${VOICE_SAMPLES} example posts, each at most ${VOICE_SAMPLE_MAX} characters.`);
    }
    samples = (b.samples as string[]).map((x) => x.trim()).filter((x) => x.length >= 10);
  }
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== 'boolean') return failCode(400, 'invalid_enabled', 'enabled must be true or false.');
    enabled = b.enabled;
  }
  await saveVoice(env, auth.userId, { description, samples, enabled });
  return json({ ok: true, description, samples, enabled, limits });
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET, POST');
