/**
 * Telegram Bot API integration.
 *
 *   validateTelegramBot(botToken, chatId)  → can this bot see the chat AND post to it?
 *   sendTelegramPost(botToken, chatId, content, mediaUrl?) → sendMessage / sendPhoto
 *
 * Security notes
 *  - The bot token lives in the request URL (that's how the Bot API works), so this file never
 *    logs URLs or raw fetch errors, and error messages returned to callers never contain the token.
 *  - The token and chat id are format-checked BEFORE they are put into a URL.
 *  - Every call has a hard timeout so a slow Telegram can't hang a request or the cron worker.
 *
 * This file is NOT a route: it only exports helpers (Pages ignores files without onRequest*).
 */

import { mediaKindFromUrl } from '../lib/media';

const TG_API = 'https://api.telegram.org';
const TIMEOUT_MS = 8_000;           // lookups and plain text
const PHOTO_TIMEOUT_MS = 20_000;    // Telegram downloads the photo (≤ 5 MB) before answering
const VIDEO_TIMEOUT_MS = 60_000;    // ...and the video (≤ 20 MB)

export const TELEGRAM_TEXT_LIMIT = 4096;
export const TELEGRAM_CAPTION_LIMIT = 1024;

// ───────────────────────── input validation ─────────────────────────
const BOT_TOKEN_RE = /^\d{6,12}:[A-Za-z0-9_-]{30,60}$/;

export const isValidBotToken = (t: unknown): t is string => typeof t === 'string' && BOT_TOKEN_RE.test(t);

/** Accepts "@channelname", "-1001234567890" or a number. Returns a clean string or null. */
export function normalizeChatId(v: unknown): string | null {
  if (typeof v === 'number' && Number.isSafeInteger(v)) return String(v);
  if (typeof v !== 'string') return null;
  const s = v.trim();
  // Convenience: accept a pasted channel link such as https://t.me/mychannel
  const link = /^(?:https?:\/\/)?(?:t|telegram)\.me\/([A-Za-z][A-Za-z0-9_]{4,31})\/?$/i.exec(s);
  if (link) return '@' + link[1];
  if (/^-?\d{1,20}$/.test(s)) return s;
  if (/^@[A-Za-z][A-Za-z0-9_]{4,31}$/.test(s)) return s;
  return null;
}

export function isValidMediaUrl(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > 2048) return false;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && !u.username && !u.password;
  } catch {
    return false;
  }
}

// ───────────────────────── low-level call ─────────────────────────
type TgOk<T> = { ok: true; result: T };
type TgErr = { ok: false; errorCode: number; description: string; retryAfter?: number; network?: boolean; timedOut?: boolean };

async function tgCall<T>(botToken: string, method: string, params: Record<string, unknown>, timeoutMs = TIMEOUT_MS): Promise<TgOk<T> | TgErr> {
  let res: Response;
  try {
    res = await fetch(`${TG_API}/bot${botToken}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    // Deliberately drop the error object: some runtimes include the URL (= the token) in it.
    const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { ok: false, errorCode: 0, description: timedOut ? 'Telegram did not answer in time' : 'Network error', network: true, timedOut };
  }

  let data: { ok?: boolean; result?: T; error_code?: number; description?: string; parameters?: { retry_after?: number } } | null = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON error page */
  }

  if (data?.ok) return { ok: true, result: data.result as T };
  return {
    ok: false,
    errorCode: data?.error_code ?? res.status,
    description: String(data?.description ?? `HTTP ${res.status}`).slice(0, 200),
    retryAfter: data?.parameters?.retry_after,
  };
}

// ───────────────────────── validateTelegramBot ─────────────────────────
export type TelegramValidation =
  | {
      ok: true;
      /** Canonical numeric chat id: store THIS (an @username can change, the id can't). */
      chatId: string;
      chatType: string;
      chatTitle: string | null;
      botUsername: string | null;
      /** the bot's role in the chat: 'creator' | 'administrator' | 'member' | 'restricted' | 'private' */
      botStatus: string;
    }
  | {
      ok: false;
      code: 'bad_input' | 'invalid_token' | 'chat_not_found' | 'no_permission' | 'rate_limited' | 'network';
      error: string;
    };

interface TgChat { id: number; type: 'private' | 'group' | 'supergroup' | 'channel'; title?: string; username?: string; first_name?: string }
interface TgMember { status: string; can_post_messages?: boolean; can_send_messages?: boolean; is_member?: boolean }

export async function validateTelegramBot(botToken: string, chatId: string): Promise<TelegramValidation> {
  if (!isValidBotToken(botToken)) {
    return { ok: false, code: 'bad_input', error: 'Bot token format is invalid. Copy it from @BotFather.' };
  }
  const chat = normalizeChatId(chatId);
  if (!chat) {
    return { ok: false, code: 'bad_input', error: 'Chat ID must be @channelname or a numeric id like -1001234567890.' };
  }

  const map = (e: TgErr): TelegramValidation => {
    if (e.network) return { ok: false, code: 'network', error: 'Could not reach Telegram. Try again in a moment.' };
    if (e.errorCode === 429) return { ok: false, code: 'rate_limited', error: 'Telegram is rate limiting requests. Try again shortly.' };
    if (e.errorCode === 401) return { ok: false, code: 'invalid_token', error: 'Telegram rejected this bot token.' };
    if (e.errorCode === 403) return { ok: false, code: 'no_permission', error: 'The bot was removed from this chat or blocked.' };
    if (e.errorCode === 400) return { ok: false, code: 'chat_not_found', error: 'Chat not found. Check the id and add the bot to the chat as an admin.' };
    return { ok: false, code: 'network', error: 'Telegram returned an unexpected error. Try again later.' };
  };

  // 1) Can the bot see the chat at all?
  const c = await tgCall<TgChat>(botToken, 'getChat', { chat_id: chat });
  if (!c.ok) return map(c);
  const info = c.result;
  const base = {
    ok: true as const,
    chatId: String(info.id),
    chatType: info.type,
    chatTitle: info.title ?? info.username ?? info.first_name ?? null,
  };

  // 2) Who is the bot?
  const me = await tgCall<{ id: number; username?: string }>(botToken, 'getMe', {});
  if (!me.ok) return map(me);
  const ok = { ...base, botUsername: me.result.username ?? null, botStatus: 'private' };

  // Private chats have no member roles: getChat succeeding means the user has started the bot.
  if (info.type === 'private') return ok;

  // 3) Does the bot have the right to POST there?
  const m = await tgCall<TgMember>(botToken, 'getChatMember', { chat_id: info.id, user_id: me.result.id });
  if (!m.ok) return map(m);
  const { status, can_post_messages, can_send_messages, is_member } = m.result;
  const ok2 = { ...ok, botStatus: status };

  if (info.type === 'channel') {
    if (status === 'creator') return ok2;
    if (status === 'administrator' && can_post_messages === true) return ok2;
    return {
      ok: false,
      code: 'no_permission',
      error: 'Make the bot an administrator of the channel with the "Post messages" permission.',
    };
  }

  // group / supergroup
  if (status === 'creator' || status === 'administrator' || status === 'member') return ok2;
  if (status === 'restricted' && is_member !== false && can_send_messages !== false) return ok2;
  return { ok: false, code: 'no_permission', error: 'The bot is not allowed to send messages in this group.' };
}

// ───────────────────────── sendTelegramPost ─────────────────────────
export type TelegramSendResult =
  | { ok: true; messageId: number }
  | {
      ok: false;
      error: string;
      /** true → worth retrying later (network, 429, 5xx). false → will fail the same way again. */
      retryable: boolean;
      retryAfter?: number;
    };

export async function sendTelegramPost(
  botToken: string,
  chatId: string,
  content: string,
  mediaUrl?: string,
): Promise<TelegramSendResult> {
  const permanent = (error: string): TelegramSendResult => ({ ok: false, error, retryable: false });

  if (!isValidBotToken(botToken)) return permanent('Invalid bot token format');
  const chat = normalizeChatId(chatId);
  if (!chat) return permanent('Invalid chat id');

  const hasMedia = mediaUrl !== undefined && mediaUrl !== null && mediaUrl !== '';
  if (hasMedia && !isValidMediaUrl(mediaUrl)) return permanent('mediaUrl must be a public https URL');
  if (!hasMedia && content.trim() === '') return permanent('Nothing to send: empty text and no media');

  // Pre-check limits so we don't burn an API call (or retry forever) on a doomed request.
  // Media + long text would need two messages; a partial failure would then duplicate the media
  // on retry, so we refuse it outright instead.
  if (hasMedia && content.length > TELEGRAM_CAPTION_LIMIT) {
    return permanent(`With an image or video, Telegram allows at most ${TELEGRAM_CAPTION_LIMIT} characters of text`);
  }
  if (!hasMedia && content.length > TELEGRAM_TEXT_LIMIT) {
    return permanent(`Telegram allows at most ${TELEGRAM_TEXT_LIMIT} characters per message`);
  }

  // No parse_mode on purpose: plain text can never fail with "can't parse entities".
  const kind = hasMedia ? mediaKindFromUrl(mediaUrl) : null;
  const caption = content ? { caption: content } : {};
  const r =
    kind === 'video'
      ? await tgCall<{ message_id: number }>(botToken, 'sendVideo', { chat_id: chat, video: mediaUrl, supports_streaming: true, ...caption }, VIDEO_TIMEOUT_MS)
      : kind === 'image'
        ? await tgCall<{ message_id: number }>(botToken, 'sendPhoto', { chat_id: chat, photo: mediaUrl, ...caption }, PHOTO_TIMEOUT_MS)
        : await tgCall<{ message_id: number }>(botToken, 'sendMessage', { chat_id: chat, text: content });

  if (r.ok) return { ok: true, messageId: r.result.message_id };

  // A send that timed out is AMBIGUOUS: Telegram may still have published it. Retrying could post it
  // twice, so we stop and tell the user (same at-most-once rule the scheduler uses elsewhere).
  if (r.timedOut) {
    return permanent('Telegram did not confirm delivery in time. The post may already be published: check the channel before rescheduling.');
  }
  if (r.network) return { ok: false, error: r.description, retryable: true };
  if (r.errorCode === 429) {
    return { ok: false, error: 'Telegram rate limit hit', retryable: true, retryAfter: r.retryAfter };
  }
  if (r.errorCode >= 500) return { ok: false, error: 'Telegram server error', retryable: true };
  if (r.errorCode === 401) return permanent('Telegram rejected the bot token');
  if (r.errorCode === 403) return permanent('The bot was removed from the chat or lost its permissions');
  if (hasMedia && r.errorCode === 400) {
    return permanent(
      kind === 'video'
        ? 'Telegram could not download the video (it must be an MP4 under 20 MB at a public link)'
        : 'Telegram could not use the image URL (it must be a public direct link to a photo)',
    );
  }
  return permanent(`Telegram refused the message: ${r.description}`);
}

// ───────────────────────── membership lookup ─────────────────────────
/**
 * Is `userId` a creator/administrator of the chat? Used to confirm a verification code posted in a
 * group really came from one of its admins. Returns null when Telegram can't tell us.
 */
export async function isChatAdmin(botToken: string, chatId: string, userId: number): Promise<boolean | null> {
  if (!isValidBotToken(botToken) || !normalizeChatId(chatId) || !Number.isSafeInteger(userId)) return null;
  const r = await tgCall<{ status: string }>(botToken, 'getChatMember', { chat_id: chatId, user_id: userId });
  if (!r.ok) return null;
  return r.result.status === 'creator' || r.result.status === 'administrator';
}
