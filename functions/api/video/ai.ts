/**
 * Vane Studio AI (see ../lib/videoai.ts, AI_FEATURES_SPEC.md §3.5). Needs an active Vane Studio.
 *
 *   GET  /api/video/ai   → { available, tools, platforms, ai: { limit, used, remaining } }
 *   POST /api/video/ai   { tool, text, platform, tone?, durationSec? }
 *
 *   tool "script"    a voice-over script from an idea (`text`)       → { hook, body, cta, script, words, estimatedSeconds }
 *   tool "metadata"  titles, description, tags / hashtags for a script → { titles, description, tags, hashtags }
 *   tool "chapters"  chapter titles with estimated times (long video; `durationSec` = the video's length) → { chapters: [{time, seconds, title}] }
 *
 * platform: youtube | shorts | tiktok | reels. One generation = one credit of the monthly allowance, given back when the model fails.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { AiError, TONES, type Tone } from '../lib/ai';
import { requireUser } from '../lib/auth';
import { failCode, fail, isRecord, json, methodNotAllowed, readJson } from '../lib/http';
import { bump, retryAfter } from '../lib/throttle';
import { nowSeconds } from '../lib/usage';
import {
  clampSeconds, isVideoPlatform, isVideoTool, MAX_IDEA_CHARS, MAX_SCRIPT_CHARS, releaseVideoAi, reserveVideoAi, toolChapters, toolMetadata, toolScript,
  videoAiUsage, VIDEO_PLATFORMS, VIDEO_TOOLS,
} from '../lib/videoai';
import { requireVideoAccess } from '../lib/videoplans';

const PER_HOUR = 60;

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  const denied = await requireVideoAccess(env, auth.userId);
  if (denied) return denied;
  return json({ ok: true, available: !!env.AI, tools: VIDEO_TOOLS, platforms: VIDEO_PLATFORMS, tones: TONES, ai: await videoAiUsage(env, auth.userId, nowSeconds()) });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  const denied = await requireVideoAccess(env, auth.userId);
  if (denied) return denied;
  const parsed = await readJson(request, 32_768);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  if (!isRecord(body)) return fail(400, 'Body must be a JSON object');

  if (!isVideoTool(body.tool)) return failCode(400, 'invalid_tool', `tool must be one of: ${VIDEO_TOOLS.join(', ')}`);
  if (!isVideoPlatform(body.platform)) return failCode(400, 'invalid_platform', `platform must be one of: ${VIDEO_PLATFORMS.join(', ')}`);
  const tool = body.tool, platform = body.platform;
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) return failCode(400, 'empty_text', tool === 'script' ? 'Write the idea of the video first.' : 'Paste the script first.');
  const max = tool === 'script' ? MAX_IDEA_CHARS : MAX_SCRIPT_CHARS;
  if (text.length > max) return failCode(400, 'text_too_long', `The text can be at most ${max} characters for this tool.`);

  let tone: Tone | null = null;
  if (body.tone !== undefined && body.tone !== null && body.tone !== '') {
    if (typeof body.tone !== 'string' || !(TONES as readonly string[]).includes(body.tone)) return failCode(400, 'invalid_tone', `tone must be one of: ${TONES.join(', ')}`);
    tone = body.tone as Tone;
  }
  let seconds: number | null = null;
  if (body.durationSec !== undefined && body.durationSec !== null && body.durationSec !== '') {
    if (typeof body.durationSec !== 'number' || !Number.isFinite(body.durationSec) || body.durationSec <= 0 || body.durationSec > 36_000) return failCode(400, 'invalid_duration', 'durationSec must be a number of seconds.');
    seconds = Math.round(body.durationSec);
  }
  if (tool === 'chapters') {
    if (platform !== 'youtube') return failCode(400, 'invalid_platform', 'Chapters are for long YouTube videos.');
    if (seconds === null) return failCode(400, 'invalid_duration', 'durationSec (the length of the video, in seconds) is required for chapters.');
  }
  if (!env.AI) return failCode(503, 'ai_unavailable', 'AI is not enabled on this server yet.');

  const key = `ai:video:${auth.userId}`;
  const wait = await retryAfter(env, key, PER_HOUR);
  if (wait) return failCode(429, 'rate_limited', 'Too many AI requests. Try again a little later.', {}, { 'Retry-After': String(wait) });
  await bump(env, key, 3600);

  const now = nowSeconds();
  if (!(await reserveVideoAi(env, auth.userId, now))) {
    return failCode(402, 'ai_quota_exceeded', 'You have used this month\'s AI generations in Vane Studio. They renew next month.', { ai: await videoAiUsage(env, auth.userId, now) });
  }

  try {
    let result: Record<string, unknown>;
    if (tool === 'script') result = { ...(await toolScript(env, text, platform, clampSeconds(platform, seconds), tone)) };
    else if (tool === 'metadata') result = { ...(await toolMetadata(env, text, platform)) };
    else result = { chapters: await toolChapters(env, text, seconds as number) };
    return json({ ok: true, tool, platform, ...result, ai: await videoAiUsage(env, auth.userId, now) });
  } catch (err) {
    await releaseVideoAi(env, auth.userId, now);
    if (err instanceof AiError) return failCode(err.status, err.code, err.message);
    console.error('video ai failed', err instanceof Error ? err.message : 'unknown');
    return failCode(500, 'ai_failed', 'Something went wrong. Try again.');
  }
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET, POST');
