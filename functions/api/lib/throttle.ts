/** Fixed-window rate limiting backed by the `rate_limits` table. */
import type { Env } from '../../../types';

export const clientIp = (request: Request): string => request.headers.get('cf-connecting-ip') ?? 'unknown';

/** Seconds until the key is allowed again, or 0 if it is currently allowed. */
export async function retryAfter(env: Env, key: string, max: number): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB
    .prepare('SELECT count, reset_at FROM rate_limits WHERE key = ?1')
    .bind(key)
    .first<{ count: number; reset_at: number }>();
  return row && row.reset_at > now && row.count >= max ? row.reset_at - now : 0;
}

/** Count one event; the window starts at the first event. */
export async function bump(env: Env, key: string, windowSeconds: number): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB
    .prepare(
      `INSERT INTO rate_limits (key, count, reset_at) VALUES (?1, 1, ?2)
       ON CONFLICT(key) DO UPDATE SET
         count    = CASE WHEN reset_at <= ?3 THEN 1 ELSE count + 1 END,
         reset_at = CASE WHEN reset_at <= ?3 THEN ?2 ELSE reset_at END`,
    )
    .bind(key, now + windowSeconds, now)
    .run();
}

export async function clear(env: Env, key: string): Promise<void> {
  await env.DB.prepare('DELETE FROM rate_limits WHERE key = ?1').bind(key).run();
}
