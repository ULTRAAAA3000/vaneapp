/**
 * POST /api/telegram/webhook — receives updates for the shared Vane bot.
 *
 * Its only job today: notice a Quick Connect verification code posted in a channel or group and
 * mark it verified. Telegram calls this URL after `setWebhook` (see scripts/telegram-webhook.mjs).
 *
 * Authenticity: Telegram sends our TELEGRAM_WEBHOOK_SECRET in the X-Telegram-Bot-Api-Secret-Token
 * header; anything without it is rejected, so nobody can forge "verified" events.
 * Always answers 200 to genuine updates (even ignored ones) so Telegram never retries them.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { isChatAdmin } from '../channels/telegram';
import { CODE_RE } from '../channels/quick';
import { fail, isRecord, json, methodNotAllowed, readJson, safeEqualStrings } from '../lib/http';

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.SYSTEM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) return fail(503, 'Not configured');
  if (!safeEqualStrings(request.headers.get('x-telegram-bot-api-secret-token') ?? '', env.TELEGRAM_WEBHOOK_SECRET)) {
    return fail(401, 'Unauthorized');
  }

  const parsed = await readJson(request, 64 * 1024);
  if (!parsed.ok) return parsed.response;
  const update = parsed.data;
  if (!isRecord(update)) return json({ ok: true });

  // A channel post, or a message in a group. (Edits and everything else are ignored.)
  const post = isRecord(update.channel_post) ? update.channel_post : isRecord(update.message) ? update.message : null;
  if (!post || !isRecord(post.chat)) return json({ ok: true });

  const chat = post.chat;
  if (chat.type !== 'channel' && chat.type !== 'group' && chat.type !== 'supergroup') return json({ ok: true });
  if (typeof chat.id !== 'number') return json({ ok: true });

  const text = typeof post.text === 'string' ? post.text : typeof post.caption === 'string' ? post.caption : '';
  const m = CODE_RE.exec(text);
  if (!m) return json({ ok: true });

  const chatId = String(chat.id);
  const code = `VANE-${m[1].toUpperCase()}`;
  const now = Math.floor(Date.now() / 1000);

  // The code is bound to ONE chat: posting it anywhere else does nothing.
  const row = await env.DB
    .prepare('SELECT id FROM telegram_verifications WHERE code = ?1 AND chat_id = ?2 AND verified_at IS NULL AND expires_at > ?3')
    .bind(code, chatId, now)
    .first<{ id: string }>();
  if (!row) return json({ ok: true });

  // In channels only admins can post, so the post itself is the proof. In groups anyone can write,
  // so the sender must be verified as an admin of that group.
  if (chat.type !== 'channel') {
    const senderId = isRecord(post.from) && typeof post.from.id === 'number' ? post.from.id : null;
    if (senderId === null || (await isChatAdmin(env.SYSTEM_BOT_TOKEN, chatId, senderId)) !== true) return json({ ok: true });
  }

  await env.DB
    .prepare('UPDATE telegram_verifications SET verified_at = ?1 WHERE id = ?2 AND verified_at IS NULL')
    .bind(now, row.id)
    .run();
  return json({ ok: true });
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('POST');
