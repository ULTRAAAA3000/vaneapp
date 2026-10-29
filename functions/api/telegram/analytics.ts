/**
 * POST /api/telegram/analytics — updates for the Vane Analytics bot (its own bot, its own token).
 * Telegram sends ANALYTICS_BOT_SECRET in X-Telegram-Bot-Api-Secret-Token; anything without it is refused.
 * Genuine updates always get 200 so Telegram never retries them.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { handleUpdate, type Update } from '../lib/analyticsbot';
import { fail, isRecord, json, methodNotAllowed, readJson, safeEqualStrings } from '../lib/http';

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.ANALYTICS_BOT_TOKEN || !env.ANALYTICS_BOT_SECRET) return fail(503, 'Not configured');
  if (!safeEqualStrings(request.headers.get('x-telegram-bot-api-secret-token') ?? '', env.ANALYTICS_BOT_SECRET)) return fail(401, 'Unauthorized');
  const parsed = await readJson(request, 64 * 1024);
  if (!parsed.ok) return parsed.response;
  if (!isRecord(parsed.data)) return json({ ok: true });
  try {
    await handleUpdate(env, parsed.data as Update, Math.floor(Date.now() / 1000));
  } catch (err) {
    console.error('analytics bot update failed:', err instanceof Error ? err.message : 'unknown');
  }
  return json({ ok: true });
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('POST');
