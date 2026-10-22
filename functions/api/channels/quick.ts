/**
 * Quick Connect: publish through the shared Vane bot (@VanePublishBot) instead of the user's own bot.
 *
 *   1. POST /api/channels/quick/start  { chat }   → checks the bot's rights, issues a one-time code
 *   2. the user posts that code in their channel (only an admin can)
 *   3. the bot receives it via the webhook (../telegram/webhook.ts) and marks the code verified
 *   4. GET  /api/channels/quick/status?id=…       → the dashboard polls until verified
 *   5. POST /api/channels/add { method:'quick', credentials:{ verificationId } } → channel is created
 *
 * WHY step 2 exists: the shared bot is an admin in MANY channels. "The bot can post in X" proves the
 * owner of X trusts the bot, NOT that this Vane user owns X. Without the code, anyone could connect a
 * channel that isn't theirs and post to it.
 *
 * This file only exports handlers/helpers (route files: ./quick/start.ts, ./quick/status.ts).
 */
import { networkOff } from '../lib/networks';
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { requireUser } from '../lib/auth';
import { fail, isRecord, json, readJson, UUID_RE } from '../lib/http';
import { bump, retryAfter } from '../lib/throttle';
import { findDuplicateTelegramChannel } from './credentials';
import { normalizeChatId, validateTelegramBot } from './telegram';

export const CODE_TTL_SECONDS = 15 * 60;          // time to post the code
export const VERIFIED_VALID_SECONDS = 30 * 60;    // time to finish connecting after it was seen
const STARTS_PER_HOUR = 10;

// No 0/O, 1/I/L: the code is typed or copied by people.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_RE = /VANE-([A-HJKMNP-Z2-9]{8})/i;

export function newVerificationCode(): string {
  let out = '';
  const limit = 256 - (256 % ALPHABET.length);     // reject biased bytes
  while (out.length < 8) {
    for (const b of crypto.getRandomValues(new Uint8Array(16))) {
      if (b < limit && out.length < 8) out += ALPHABET[b % ALPHABET.length];
    }
  }
  return `VANE-${out}`;
}

/** Quick Connect needs both the shared bot's token and the webhook secret. */
export const quickConnectAvailable = (env: Pick<Env, 'SYSTEM_BOT_TOKEN' | 'TELEGRAM_WEBHOOK_SECRET'>): boolean =>
  Boolean(env.SYSTEM_BOT_TOKEN && env.TELEGRAM_WEBHOOK_SECRET);

export const systemBotHandle = (env: Pick<Env, 'SYSTEM_BOT_USERNAME'>): string =>
  '@' + (env.SYSTEM_BOT_USERNAME || 'VanePublishBot').replace(/^@/, '');

const NOT_AVAILABLE = 'Quick Connect is not available on this server yet. Connect with your own bot instead.';

// ───────────────────────── POST /api/channels/quick/start ─────────────────────────
export const handleQuickStart: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  if (!quickConnectAvailable(env)) return fail(503, NOT_AVAILABLE);
  const paused = await networkOff(env, 'telegram');   // switched off in /admin → Networks
  if (paused) return paused;

  const parsed = await readJson(request, 4096);
  if (!parsed.ok) return parsed.response;
  if (!isRecord(parsed.data)) return fail(400, 'Body must be a JSON object');
  const chat = normalizeChatId(parsed.data.chat);
  if (!chat) return fail(400, 'Enter the channel as @channelname (or a t.me link, or its numeric id).');

  // Every start makes Telegram calls: cap it per user.
  const rlKey = `quick:${auth.userId}`;
  const wait = await retryAfter(env, rlKey, STARTS_PER_HOUR);
  if (wait) return fail(429, 'Too many attempts. Try again in a few minutes.', { 'Retry-After': String(wait) });
  await bump(env, rlKey, 3600);

  const check = await validateTelegramBot(env.SYSTEM_BOT_TOKEN!, chat);
  if (!check.ok) {
    if (check.code === 'invalid_token') {
      console.error('quick connect: SYSTEM_BOT_TOKEN was rejected by Telegram');
      return fail(503, NOT_AVAILABLE);
    }
    return fail(check.code === 'network' || check.code === 'rate_limited' ? 502 : 400, check.error);
  }
  const bot = systemBotHandle(env);
  if (check.chatType === 'private') return fail(400, 'Quick Connect works with channels and groups. For a private chat use your own bot.');
  if (check.chatType !== 'channel' && check.botStatus !== 'administrator' && check.botStatus !== 'creator') {
    return fail(400, `Make ${bot} an administrator of the group so it can see your verification message.`);
  }

  const dup = await findDuplicateTelegramChannel(env.DB, env.ENCRYPTION_KEY, auth.userId, check.chatId);
  if (dup) return fail(409, `This chat is already connected as "${dup}".`);

  // Reuse a still-valid pending code instead of issuing a new one on every click.
  const now = Math.floor(Date.now() / 1000);
  const pending = await env.DB
    .prepare(`SELECT id, code, expires_at FROM telegram_verifications WHERE user_id = ?1 AND chat_id = ?2 AND verified_at IS NULL AND expires_at > ?3`)
    .bind(auth.userId, check.chatId, now)
    .first<{ id: string; code: string; expires_at: number }>();

  let row = pending;
  if (!row) {
    row = { id: crypto.randomUUID(), code: newVerificationCode(), expires_at: now + CODE_TTL_SECONDS };
    try {
      await env.DB
        .prepare(`INSERT INTO telegram_verifications (id, user_id, chat_id, chat_title, chat_type, code, created_at, expires_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`)
        .bind(row.id, auth.userId, check.chatId, check.chatTitle, check.chatType, row.code, now, row.expires_at)
        .run();
    } catch (err) {
      console.error('verification insert failed', err instanceof Error ? err.message : 'unknown');
      return fail(500, 'Could not start the verification. Please try again.');
    }
  }

  return json({
    ok: true,
    verificationId: row.id,
    code: row.code,
    expiresAt: row.expires_at,
    bot,
    chat: { title: check.chatTitle, type: check.chatType },
  });
};

// ───────────────────────── GET /api/channels/quick/status?id=… ─────────────────────────
export const handleQuickStatus: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;

  const id = new URL(request.url).searchParams.get('id') ?? '';
  if (!UUID_RE.test(id)) return fail(404, 'Verification not found. Start again.');

  const row = await env.DB
    .prepare('SELECT verified_at, expires_at FROM telegram_verifications WHERE id = ?1 AND user_id = ?2')
    .bind(id, auth.userId)
    .first<{ verified_at: number | null; expires_at: number }>();
  if (!row) return fail(404, 'Verification not found. Start again.');

  const now = Math.floor(Date.now() / 1000);
  return json({ ok: true, verified: row.verified_at !== null, expired: row.verified_at === null && row.expires_at <= now, expiresAt: row.expires_at });
};
