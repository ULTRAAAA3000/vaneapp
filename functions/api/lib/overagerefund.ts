import type { D1Database } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { refundBalance } from './balance';

const INTERRUPTED = 'Delivery was interrupted%';

interface IdleCharge {
  id: number;
  user_id: string;
  source: 'api' | 'ui';
  units: number;
  cost_micro_usd: number;
  created_at: number;
}

export async function refundIdleOverage(db: D1Database, now: number, userId?: string): Promise<number> {
  const { results } = await db
    .prepare(
      `SELECT l.id, l.user_id, l.source, l.units, l.cost_micro_usd, l.created_at
       FROM usage_logs l
       WHERE l.kind = 'post' AND l.overage = 1 AND l.refunded_at IS NULL AND l.ref IS NOT NULL
         AND (?2 IS NULL OR l.user_id = ?2)
         AND l.created_at >= CAST(strftime('%s', ?1, 'unixepoch', 'start of month') AS INTEGER)
         AND EXISTS (SELECT 1 FROM posts p WHERE p.group_id = l.ref)
         AND NOT EXISTS (
           SELECT 1 FROM posts p WHERE p.group_id = l.ref
             AND (p.status NOT IN ('cancelled', 'failed') OR (p.status = 'failed' AND p.error LIKE ?3))
         )
       LIMIT 200`,
    )
    .bind(now, userId ?? null, INTERRUPTED)
    .all<IdleCharge>();

  let refunded = 0;
  for (const c of results ?? []) {
    const claimed = await db
      .prepare('UPDATE usage_logs SET refunded_at = ?2 WHERE id = ?1 AND refunded_at IS NULL')
      .bind(c.id, now)
      .run();
    if ((claimed.meta?.changes ?? 0) === 0) continue;
    const period = new Date(c.created_at * 1000).toISOString().slice(0, 7);
    const column = c.source === 'ui' ? 'ui_posts' : 'api_posts';
    await db
      .prepare(
        `UPDATE usage_counters SET
           ${column} = MAX(${column} - ?3, 0),
           overage_posts = MAX(overage_posts - ?3, 0),
           overage_micro_usd = MAX(overage_micro_usd - ?4, 0),
           updated_at = ?5
         WHERE user_id = ?1 AND period = ?2`,
      )
      .bind(c.user_id, period, c.units, c.cost_micro_usd, now)
      .run();
    // The price was taken from the prepaid balance when the post was accepted, so it goes back there. (An unmigrated database has no
    // balance, and then nothing was ever charged: the counters above are all there is to give back.)
    await refundBalance({ DB: db } as unknown as Env, c.user_id, c.cost_micro_usd, 'post', now)
      .catch((err: unknown) => console.error('balance refund failed', err instanceof Error ? err.message : 'unknown'));
    refunded++;
  }
  return refunded;
}
