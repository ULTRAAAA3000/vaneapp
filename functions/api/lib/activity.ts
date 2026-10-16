/**
 * "When did this person last use Vane?" for one rule: an account nobody has opened for more than
 * 3 days must be confirmed again with an emailed code (login.ts asks for it at sign-in, requireUser
 * ends sessions that sat idle that long).
 *
 * Used only while emailed codes are on (mail.ts: emailConfigured), so otherwise the table is never touched.
 */
import type { Env } from '../../../types';
import { revokeSessions } from './session';

export const AWAY_AFTER_SECONDS = 3 * 24 * 3600;
const TOUCH_EVERY_SECONDS = 3600; // at most one write an hour per user, however busy the dashboard is (so "3 days" is ±1 h)

/** unix seconds, or null when nothing is recorded yet (accounts from before this feature, or never active). */
export async function lastSeen(env: Env, userId: string): Promise<number | null> {
  const row = await env.DB
    .prepare('SELECT last_seen_at FROM user_activity WHERE user_id = ?1')
    .bind(userId)
    .first<{ last_seen_at: number }>();
  return row?.last_seen_at ?? null;
}

/** Nothing recorded counts as "not away": existing accounts get a fresh start when the feature is switched on. */
export const awayTooLong = (seen: number | null, now: number = Math.floor(Date.now() / 1000)): boolean =>
  seen !== null && now - seen > AWAY_AFTER_SECONDS;

export async function markSeen(env: Env, userId: string): Promise<void> {
  await env.DB
    .prepare('INSERT INTO user_activity (user_id, last_seen_at) VALUES (?1, ?2) ON CONFLICT(user_id) DO UPDATE SET last_seen_at = ?2')
    .bind(userId, Math.floor(Date.now() / 1000))
    .run();
}

/**
 * For a request that arrives with a live session cookie. false = the user was away too long: every
 * session of theirs has just been ended, so they must sign in again and enter a code.
 * Fails open: if this bookkeeping breaks (say the schema was not applied yet) the dashboard stays up.
 */
export async function stillActive(env: Env, userId: string): Promise<boolean> {
  try {
    const now = Math.floor(Date.now() / 1000);
    const seen = await lastSeen(env, userId);
    if (awayTooLong(seen, now)) {
      await revokeSessions(env, userId);
      return false;
    }
    if (seen === null || now - seen >= TOUCH_EVERY_SECONDS) await markSeen(env, userId);
  } catch (err) {
    console.error('activity check failed', err instanceof Error ? err.message : 'unknown');
  }
  return true;
}
