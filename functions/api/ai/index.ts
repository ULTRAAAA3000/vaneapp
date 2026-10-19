/**
 * The AI tools of the dashboard editor (see ../lib/ai.ts, AI_FEATURES_SPEC.md).
 *
 *   GET  /api/ai     → { available, tools, ai: { limit, used, remaining, perGenerationUsd } }
 *   POST /api/ai     { tool, text, tone?, networks? }
 *
 *   tool "clean"     Make it clean: typos, grammar, emoji            → { text }                 free
 *   tool "hashtags"  hashtags for the text                           → { hashtags: [] }         free
 *   tool "tone"      rewrite in tone professional|viral|friendly|tech → { text }                 1 AI credit
 *   tool "hook"      3 opening lines                                  → { options: [] }          1 AI credit
 *   tool "cta"       3 calls to action                                → { options: [] }          1 AI credit
 *   tool "reformat"  one version per network in `networks`            → { variants: [{platform,text,length,limit}] }   1 AI credit
 *   tool "generate"  a finished post from a short idea (`text`)       → { text }                 1 AI credit
 *   tool "plan"      7 post drafts for a topic (`text`)               → { items: [{day,text}] }  1 AI credit
 *
 * `networks` (platform names of the selected channels) makes the answer fit the tightest of them.
 * A credit is taken before the model runs and given back if the model fails.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { ChannelType, Env } from '../../../types';
import {
  AiError, FREE_TOOLS, inputLimit, isAiTool, isPremiumTool, PREMIUM_TOOLS, TONES, toolClean, toolCta, toolGenerate, toolHashtags, toolHook,
  toolPlan, toolReformat, toolTone, type Tone,
} from '../lib/ai';
import { requireUser } from '../lib/auth';
import { fail, failCode, isRecord, json, methodNotAllowed, readJson } from '../lib/http';
import { CONTENT_LIMIT } from '../posts/create';
import { bump, retryAfter } from '../lib/throttle';
import { aiLogStatement, loadSubscription, nowSeconds, releaseAiGeneration, reserveAiGeneration, usageSummary } from '../lib/usage';

const FREE_PER_HOUR = 60;
const PAID_PER_HOUR = 60;

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  const usage = await usageSummary(env, auth.userId, await loadSubscription(env, auth.userId));
  return json({ ok: true, available: !!env.AI, tools: { free: FREE_TOOLS, premium: PREMIUM_TOOLS, tones: TONES }, ai: usage.ai });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  const parsed = await readJson(request, 16_384);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  if (!isRecord(body)) return fail(400, 'Body must be a JSON object');

  if (!isAiTool(body.tool)) return failCode(400, 'invalid_tool', 'Unknown AI tool.');
  const tool = body.tool;
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) return failCode(400, 'empty_text', tool === 'generate' || tool === 'plan' ? 'Write a short idea first.' : 'Write some text first.');
  if (text.length > inputLimit(tool)) return failCode(400, 'text_too_long', `The text can be at most ${inputLimit(tool)} characters for this tool.`);

  let networks: ChannelType[] = [];
  if (body.networks !== undefined) {
    if (!Array.isArray(body.networks) || body.networks.length > 12 || !body.networks.every((n) => typeof n === 'string' && n in CONTENT_LIMIT)) {
      return failCode(400, 'invalid_networks', 'networks must be a list of network names.');
    }
    networks = [...new Set(body.networks as ChannelType[])];
  }
  let tone: Tone | null = null;
  if (body.tone !== undefined && body.tone !== null && body.tone !== '') {
    if (typeof body.tone !== 'string' || !(TONES as readonly string[]).includes(body.tone)) return failCode(400, 'invalid_tone', `tone must be one of: ${TONES.join(', ')}`);
    tone = body.tone as Tone;
  }
  if (tool === 'tone' && !tone) return failCode(400, 'invalid_tone', `tone is required: ${TONES.join(', ')}`);
  if (tool === 'reformat' && !networks.length) return failCode(400, 'invalid_networks', 'Choose at least one channel to reformat for.');
  if (!env.AI) return failCode(503, 'ai_unavailable', 'AI is not enabled on this server yet.');

  // A person can't run the model in a loop: an hour window per kind of tool.
  const premium = isPremiumTool(tool);
  const key = `ai:${premium ? 'paid' : 'free'}:${auth.userId}`;
  const wait = await retryAfter(env, key, premium ? PAID_PER_HOUR : FREE_PER_HOUR);
  if (wait) return failCode(429, 'rate_limited', 'Too many AI requests. Try again a little later.', {}, { 'Retry-After': String(wait) });
  await bump(env, key, 3600);

  const now = nowSeconds();
  const sub = await loadSubscription(env, auth.userId, now);
  let reservation: Awaited<ReturnType<typeof reserveAiGeneration>> | null = null;
  if (premium) {
    reservation = await reserveAiGeneration(env, auth.userId, sub, now);
    if (!reservation.ok) {
      const usage = await usageSummary(env, auth.userId, sub, now);
      return failCode(
        402, reservation.code,
        reservation.code === 'ai_quota_exceeded'
          ? `You have used all ${usage.ai.limit} AI credits. They renew with your plan period, or turn on extra-usage billing in your plan.`
          : 'Your plan has no AI credits. The free tools (Make it clean, hashtags) still work; choose a plan with the AI Pass for the rest.',
        { ai: usage.ai },
      );
    }
  }

  try {
    let result: Record<string, unknown>;
    switch (tool) {
      case 'clean': result = { text: await toolClean(env, text, networks) }; break;
      case 'hashtags': result = { hashtags: await toolHashtags(env, text) }; break;
      case 'tone': result = { text: await toolTone(env, text, tone as Tone, networks) }; break;
      case 'hook': result = { options: await toolHook(env, text) }; break;
      case 'cta': result = { options: await toolCta(env, text) }; break;
      case 'reformat': result = { variants: await toolReformat(env, text, networks) }; break;
      case 'generate': result = { text: await toolGenerate(env, text, tone, networks) }; break;
      default: result = { items: await toolPlan(env, text, networks) };
    }
    if (reservation && reservation.ok) {
      await aiLogStatement(env, { userId: auth.userId, overage: reservation.overage, costMicro: reservation.costMicro, ref: tool, now }).run().catch(() => undefined);
    }
    const usage = await usageSummary(env, auth.userId, sub, now);
    return json({ ok: true, tool, ...result, ai: usage.ai });
  } catch (err) {
    if (reservation && reservation.ok) await releaseAiGeneration(env, auth.userId, reservation);
    if (err instanceof AiError) return failCode(err.status, err.code, err.message);
    console.error('ai tool failed', err instanceof Error ? err.message : 'unknown');
    return failCode(500, 'ai_failed', 'Something went wrong. Try again.');
  }
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET, POST');
