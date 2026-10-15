/**
 * One place that knows how a Telegram channel's saved credentials look and how to turn them into
 * something we can send with. Used by the "Send test" endpoint AND by the cron worker.
 *
 *   mode 'custom' : { type:'telegram', mode:'custom', botToken, chatId }   the user's own bot
 *   mode 'system' : { type:'telegram', mode:'system', chatId }             the shared Vane bot;
 *                   its token is NEVER stored per channel, it comes from the SYSTEM_BOT_TOKEN secret
 *   (rows saved before Quick Connect existed have no `mode` → treated as 'custom')
 */
import { decryptToken } from '../lib/crypto';

export interface TelegramCreds { botToken: string; chatId: string; mode: 'custom' | 'system' }
export type CredsResult =
  | { ok: true; creds: TelegramCreds }
  | { ok: false; reason: 'unreadable' | 'system_bot_missing' };

export const CREDS_ERROR: Record<'unreadable' | 'system_bot_missing', string> = {
  unreadable: 'Saved credentials could not be read. Reconnect the channel.',
  system_bot_missing: 'The shared Vane bot is not configured on the server. Please contact support.',
};

interface Blob { mode: 'custom' | 'system'; botToken?: string; chatId: string }

async function readBlob(encrypted: string, encryptionKey: string | undefined): Promise<Blob | null> {
  if (!encryptionKey) return null;
  try {
    const p = JSON.parse(await decryptToken(encrypted, encryptionKey));
    if (typeof p?.chatId !== 'string' || !p.chatId) return null;
    const mode = p.mode === 'system' ? 'system' : 'custom';
    if (mode === 'custom' && typeof p.botToken !== 'string') return null;
    return { mode, botToken: p.botToken, chatId: p.chatId };
  } catch {
    return null;
  }
}

export async function loadTelegramCreds(
  encrypted: string,
  env: { ENCRYPTION_KEY?: string; SYSTEM_BOT_TOKEN?: string },
): Promise<CredsResult> {
  const blob = await readBlob(encrypted, env.ENCRYPTION_KEY);
  if (!blob) return { ok: false, reason: 'unreadable' };
  if (blob.mode === 'system') {
    return env.SYSTEM_BOT_TOKEN
      ? { ok: true, creds: { mode: 'system', botToken: env.SYSTEM_BOT_TOKEN, chatId: blob.chatId } }
      : { ok: false, reason: 'system_bot_missing' };
  }
  return { ok: true, creds: { mode: 'custom', botToken: blob.botToken!, chatId: blob.chatId } };
}

/**
 * Does this user already have this chat connected (through either method)?
 * Returns the existing channel's display name, or null. Credentials are encrypted, so we decrypt the
 * user's Telegram channels and compare: fine for the handful a person has.
 */
export async function findDuplicateTelegramChannel(
  db: D1Database,
  encryptionKey: string | undefined,
  userId: string,
  chatId: string,
): Promise<string | null> {
  const { results } = await db
    .prepare(`SELECT name, credentials FROM channels WHERE user_id = ?1 AND type = 'telegram' LIMIT 200`)
    .bind(userId)
    .all<{ name: string; credentials: string }>();
  for (const row of results) {
    const blob = await readBlob(row.credentials, encryptionKey);
    if (blob && blob.chatId === chatId) return row.name;
  }
  return null;
}
