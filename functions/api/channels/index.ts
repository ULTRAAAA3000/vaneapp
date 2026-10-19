/**
 * Channel management.  All routes require `Authorization: Bearer <jwt>`.
 *
 *   GET    /api/channels        → list my channels (NEVER returns credentials, encrypted or not)
 *   POST   /api/channels/add    → { platform, name, credentials }
 *   DELETE /api/channels/:id    → remove one of my channels
 *
 * Pages Functions route by file name, so the three handlers live here and are exposed through
 * thin route files:   add.ts → POST /api/channels/add     [id].ts → DELETE /api/channels/:id
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { ChannelPublic, ChannelRow, ChannelType, Env } from '../../../types';
import { requireUser } from '../lib/auth';
import { encryptToken } from '../lib/crypto';
import { fail, isRecord, json, methodNotAllowed, readJson, UUID_RE } from '../lib/http';
import { bump, retryAfter } from '../lib/throttle';
import { checkChannelQuota } from '../lib/catalog';
import { handleAddBluesky } from './bluesky-add';
import { CREDS_ERROR, findDuplicateTelegramChannel, loadTelegramCreds } from './credentials';
import { quickConnectAvailable, VERIFIED_VALID_SECONDS } from './quick';
import { normalizeChatId, sendTelegramPost, validateTelegramBot } from './telegram';

const CHANNEL_TYPES: readonly ChannelType[] = ['telegram', 'x', 'linkedin', 'webhook', 'bluesky', 'mastodon', 'threads'];
const CONNECTABLE: readonly ChannelType[] = ['telegram', 'bluesky'];
const MAX_NAME_LEN = 80;

const toPublic = (r: Pick<ChannelRow, 'id' | 'type' | 'name' | 'is_active' | 'created_at'>): ChannelPublic => ({
  id: r.id,
  platform: r.type,
  name: r.name,
  isActive: r.is_active === 1,
  createdAt: r.created_at,
});

// ───────────────────────── GET /api/channels ─────────────────────────
/** My channels, newest first. Shared by the dashboard route and `GET /api/v1/channels`. */
export async function channelsForUser(env: Env, userId: string): Promise<ChannelPublic[]> {
  // Explicit column list: `credentials` is deliberately never selected.
  const { results } = await env.DB
    .prepare('SELECT id, type, name, is_active, created_at FROM channels WHERE user_id = ?1 ORDER BY created_at DESC')
    .bind(userId)
    .all<Pick<ChannelRow, 'id' | 'type' | 'name' | 'is_active' | 'created_at'>>();
  return results.map(toPublic);
}

export const handleListChannels: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  return json({ ok: true, channels: await channelsForUser(env, auth.userId) });
};

// ───────────────────────── POST /api/channels/add ─────────────────────────
/**
 * Two ways to connect Telegram:
 *   method 'custom' (default)  credentials { botToken, chatId }      the user's own bot (BotFather token)
 *   method 'quick'             credentials { verificationId }        the shared Vane bot, after the user
 *                                                                    proved ownership (see ./quick.ts)
 */
export const handleAddChannel: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;

  if (!env.ENCRYPTION_KEY || env.ENCRYPTION_KEY.length < 32) {
    console.error('ENCRYPTION_KEY is missing or shorter than 32 characters');
    return fail(500, 'Server is not configured correctly');
  }

  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  if (!isRecord(body)) return fail(400, 'Body must be a JSON object');

  // platform
  const platform = body.platform;
  if (typeof platform !== 'string' || !CHANNEL_TYPES.includes(platform as ChannelType)) {
    return fail(400, `platform must be one of: ${CHANNEL_TYPES.join(', ')}`);
  }
  if (platform === 'mastodon') return fail(400, 'Mastodon connects through a sign-in on your server: POST /api/channels/mastodon/start { instance }.');
  if (!CONNECTABLE.includes(platform as ChannelType)) {
    return fail(501, `Platform "${platform}" is not supported yet. Available: ${CONNECTABLE.join(', ')}.`);
  }

  // name
  const name = typeof body.name === 'string' ? body.name.replace(/[\u0000-\u001f\u007f]/g, '').trim() : '';
  if (!name || name.length > MAX_NAME_LEN) return fail(400, `name is required (max ${MAX_NAME_LEN} characters)`);

  if (platform === 'bluesky') return handleAddBluesky(env, auth.userId, name, body.credentials);

  // method
  const method = body.method === undefined ? 'custom' : body.method;
  if (method !== 'custom' && method !== 'quick') return fail(400, 'method must be "custom" or "quick"');
  if (!isRecord(body.credentials)) {
    return fail(400, method === 'quick' ? 'credentials must be an object: { verificationId }' : 'credentials must be an object: { botToken, chatId }');
  }
  const creds = body.credentials;

  let chatIdToStore: string;
  let blob: Record<string, unknown>;
  let info: { chatType: string; chatTitle: string | null; botUsername: string | null };
  const now = Math.floor(Date.now() / 1000);
  let consumeVerification: string | null = null;

  if (method === 'custom') {
    const botToken = typeof creds.botToken === 'string' ? creds.botToken.trim() : '';
    const chatId = normalizeChatId(creds.chatId);
    if (!botToken) return fail(400, 'credentials.botToken is required');
    if (!chatId) return fail(400, 'credentials.chatId must be @channelname or a numeric id');

    // Ask Telegram: is the token real, does the chat exist, may the bot post there?
    const check = await validateTelegramBot(botToken, chatId);
    if (!check.ok) return fail(check.code === 'network' || check.code === 'rate_limited' ? 502 : 400, check.error);
    chatIdToStore = check.chatId;
    info = { chatType: check.chatType, chatTitle: check.chatTitle, botUsername: check.botUsername };
    blob = { type: 'telegram', mode: 'custom', botToken, chatId: check.chatId };
  } else {
    if (!quickConnectAvailable(env)) return fail(503, 'Quick Connect is not available on this server yet. Connect with your own bot instead.');
    const vid = typeof creds.verificationId === 'string' ? creds.verificationId : '';
    if (!UUID_RE.test(vid)) return fail(400, 'credentials.verificationId is required');

    const v = await env.DB
      .prepare('SELECT chat_id, verified_at FROM telegram_verifications WHERE id = ?1 AND user_id = ?2')
      .bind(vid, auth.userId)
      .first<{ chat_id: string; verified_at: number | null }>();
    if (!v) return fail(404, 'Verification not found. Start again.');
    if (v.verified_at === null) return fail(409, 'We have not seen your code in the channel yet. Post it there and try again.');
    if (v.verified_at + VERIFIED_VALID_SECONDS < now) return fail(410, 'This verification expired. Start again.');

    // The bot may have been removed since the code was seen: check the rights again.
    const check = await validateTelegramBot(env.SYSTEM_BOT_TOKEN!, v.chat_id);
    if (!check.ok) return fail(check.code === 'network' || check.code === 'rate_limited' ? 502 : 400, check.error);
    chatIdToStore = check.chatId;
    info = { chatType: check.chatType, chatTitle: check.chatTitle, botUsername: check.botUsername };
    blob = { type: 'telegram', mode: 'system', chatId: check.chatId };   // NO token: it comes from the server secret
    consumeVerification = vid;                                           // single use
  }

  // Connecting the same chat twice would double-post: refuse, whichever method was used before.
  const dup = await findDuplicateTelegramChannel(env.DB, env.ENCRYPTION_KEY, auth.userId, chatIdToStore);
  if (dup) return fail(409, `This chat is already connected as "${dup}".`);

  const overQuota = await checkChannelQuota(env, auth.userId);   // plan limit (only while "enforce_limits" is on)
  if (overQuota) return overQuota;

  const encrypted = await encryptToken(JSON.stringify(blob), env.ENCRYPTION_KEY);
  const id = crypto.randomUUID();
  try {
    const insert = env.DB
      .prepare(`INSERT INTO channels (id, user_id, type, name, credentials, is_active, created_at, updated_at) VALUES (?1, ?2, 'telegram', ?3, ?4, 1, ?5, ?5)`)
      .bind(id, auth.userId, name, encrypted, now);
    if (consumeVerification) {
      await env.DB.batch([insert, env.DB.prepare('DELETE FROM telegram_verifications WHERE id = ?1').bind(consumeVerification)]);
    } else {
      await insert.run();
    }
  } catch (err) {
    console.error('channel insert failed', err instanceof Error ? err.message : 'unknown');
    return fail(500, 'Could not save the channel. Please try again.');
  }

  return json({ ok: true, channel: toPublic({ id, type: 'telegram', name, is_active: 1, created_at: now }), telegram: info }, 201);
};

// ───────────────────────── DELETE /api/channels/:id ─────────────────────────
export const handleDeleteChannel: PagesFunction<Env, 'id'> = async ({ request, env, params }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;

  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  if (!id || !UUID_RE.test(id)) return fail(404, 'Channel not found');

  // Pending posts are removed together with the channel (ON DELETE CASCADE); tell the caller how many.
  const pending = await env.DB
    .prepare(`SELECT COUNT(*) AS n FROM posts WHERE channel_id = ?1 AND user_id = ?2 AND status IN ('scheduled','processing')`)
    .bind(id, auth.userId)
    .first<{ n: number }>();

  // `AND user_id` makes it impossible to delete someone else's channel; a foreign id looks like a missing one.
  const res = await env.DB
    .prepare('DELETE FROM channels WHERE id = ?1 AND user_id = ?2')
    .bind(id, auth.userId)
    .run();

  if ((res.meta?.changes ?? 0) === 0) return fail(404, 'Channel not found');
  return json({ ok: true, deletedScheduledPosts: pending?.n ?? 0 });
};

// ───────────────────────── POST /api/channels/:id/test ─────────────────────────
/** Sends a short message through the saved credentials: proves decryption + bot + permissions work end to end. */
export const handleTestChannel: PagesFunction<Env, 'id'> = async ({ request, env, params }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  if (!env.ENCRYPTION_KEY) return fail(500, 'Server is not configured correctly');

  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  if (!id || !UUID_RE.test(id)) return fail(404, 'Channel not found');

  // A test message is a real outbound call: cap it at 10 per hour per user.
  const key = `test:${auth.userId}`;
  const wait = await retryAfter(env, key, 10);
  if (wait) return fail(429, 'Too many test messages. Try again later.', { 'Retry-After': String(wait) });

  const row = await env.DB
    .prepare('SELECT type, name, credentials FROM channels WHERE id = ?1 AND user_id = ?2')
    .bind(id, auth.userId)
    .first<Pick<ChannelRow, 'type' | 'name' | 'credentials'>>();
  if (!row) return fail(404, 'Channel not found');
  if (row.type !== 'telegram') return fail(501, 'Testing is only available for Telegram channels.');

  const loaded = await loadTelegramCreds(row.credentials, env);
  if (!loaded.ok) {
    console.error(`channel credentials unusable: ${loaded.reason}`);
    return fail(loaded.reason === 'system_bot_missing' ? 503 : 500, CREDS_ERROR[loaded.reason]);
  }
  const creds = loaded.creds;

  await bump(env, key, 3600);
  const sent = await sendTelegramPost(
    creds.botToken,
    creds.chatId,
    '✅ Vane is connected. Posts you schedule to this channel will appear here.',
  );
  if (!sent.ok) return fail(502, sent.error);
  return json({ ok: true, messageId: sent.messageId });
};

// ───────────────────────── routes for this file ─────────────────────────
export const onRequestGet = handleListChannels;
export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET');
