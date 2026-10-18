import type { Env } from '../../../types';
import { clientOf } from './guard';

/** First-touch source of the new user (from the browser's anonymous visitor id); best effort. */
export async function recordAttribution(env: Env, request: Request, userId: string, visitorId: unknown): Promise<void> {
  const vid = typeof visitorId === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(visitorId) ? visitorId : null;
  const country = clientOf(request).country || null;
  try {
    const stmts = [
      env.DB
        .prepare(
          `INSERT OR IGNORE INTO user_attribution (user_id, visitor_id, ref_host, utm_source, landing_path, country)
           SELECT ?1, ?2, ref_host, utm_source, path, COALESCE(country, ?3) FROM web_views WHERE visitor_id = ?2 ORDER BY started_at ASC LIMIT 1`,
        )
        .bind(userId, vid, country),
      env.DB.prepare('INSERT OR IGNORE INTO user_attribution (user_id, visitor_id, country) VALUES (?1, ?2, ?3)').bind(userId, vid, country),
    ];
    if (vid) stmts.push(env.DB.prepare('UPDATE web_views SET user_id = ?1 WHERE visitor_id = ?2 AND user_id IS NULL').bind(userId, vid));
    await env.DB.batch(stmts);
  } catch (err) {
    console.error('attribution failed', err instanceof Error ? err.message : 'unknown');
  }
}
