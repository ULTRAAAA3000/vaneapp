/**
 * Sends the webhook events queued in `webhook_deliveries` (see functions/api/lib/webhooks.ts for the contract).
 * Runs right after the posts, every minute, from the `vane-cron` Worker.
 *
 * Guarantees
 *  - AT LEAST ONCE. A delivery is claimed with ONE atomic UPDATE … RETURNING (pending → sending), so overlapping runs
 *    can't send the same row twice. A run that dies mid-send leaves the row 'sending'; after 5 minutes it is sent again.
 *    Receivers dedupe on the event id.
 *  - RETRIES with backoff (1 min, 5 min, 15 min, 1 h), 6 attempts in all. After that the delivery is 'failed'.
 *  - A BROKEN ENDPOINT CAN'T HURT US: 8 s timeout, no redirects, 10 deliveries per run, and after 10 consecutive deliveries
 *    that failed for good the webhook is switched off. A 410 Gone switches it off at once.
 *  - FAIL SAFE. Without ENCRYPTION_KEY (needed to read the signing secrets) nothing is touched.
 */
import type { CronEnv } from '../../types';
import { decryptToken } from '../../functions/api/lib/crypto';
import { loadPostPublic } from '../../functions/api/posts/list';
import {
  DISABLE_AFTER_FAILURES, MAX_DELIVERY_ATTEMPTS, RETRY_DELAYS, sendWebhook, webhooksTablesExist,
  type EventPayload, type WebhookRow,
} from '../../functions/api/lib/webhooks';

export const WEBHOOK_BATCH_SIZE = 10;
/** A delivery 'sending' for longer than this was abandoned by a run that died. */
export const SENDING_STALE_SECONDS = 5 * 60;

interface Claimed { id: string; webhook_id: string; event: string; post_id: string | null; attempts: number; created_at: number }
type HookInfo = Pick<WebhookRow, 'id' | 'url' | 'secret' | 'active'>;
export interface WebhookRunSummary { skipped?: string; claimed: number; delivered: number; retried: number; failed: number }

const clip = (s: string, n = 300) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export async function runWebhookDeliveries(env: CronEnv, now: number = Math.floor(Date.now() / 1000)): Promise<WebhookRunSummary> {
  const summary: WebhookRunSummary = { claimed: 0, delivered: 0, retried: 0, failed: 0 };
  if (!(await webhooksTablesExist(env.DB))) return { ...summary, skipped: 'webhook tables are not in the database yet' };
  if (!env.ENCRYPTION_KEY || env.ENCRYPTION_KEY.length < 32) return { ...summary, skipped: 'ENCRYPTION_KEY not configured' };

  // Rows left 'sending' by a run that died are due again.
  await env.DB
    .prepare(`UPDATE webhook_deliveries SET status = 'pending' WHERE status = 'sending' AND next_attempt_at <= ?1`)
    .bind(now - SENDING_STALE_SECONDS)
    .run();

  // Claim due deliveries atomically (pending → sending); for 'sending' rows next_attempt_at is the claim time.
  const claimed = await env.DB
    .prepare(
      `UPDATE webhook_deliveries SET status = 'sending', attempts = attempts + 1, next_attempt_at = ?1
        WHERE id IN (SELECT id FROM webhook_deliveries WHERE status = 'pending' AND next_attempt_at <= ?1 ORDER BY next_attempt_at ASC LIMIT ?2)
        RETURNING id, webhook_id, event, post_id, attempts, created_at`,
    )
    .bind(now, WEBHOOK_BATCH_SIZE)
    .all<Claimed>();
  const deliveries = [...claimed.results].sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
  summary.claimed = deliveries.length;
  if (!deliveries.length) return summary;

  const hookIds = [...new Set(deliveries.map((d) => d.webhook_id))];
  const { results: hookRows } = await env.DB
    .prepare(`SELECT id, url, secret, active FROM webhooks WHERE id IN (${hookIds.map((_, i) => `?${i + 1}`).join(',')})`)
    .bind(...hookIds)
    .all<HookInfo>();
  const hooks = new Map(hookRows.map((h) => [h.id, h]));
  const secrets = new Map<string, string | null>();

  const finish = (id: string, status: 'done' | 'failed' | 'pending', error: string | null, nextAt?: number) =>
    env.DB
      .prepare(`UPDATE webhook_deliveries SET status = ?2, last_error = ?3, delivered_at = CASE WHEN ?2 = 'done' THEN ?4 ELSE delivered_at END, next_attempt_at = COALESCE(?5, next_attempt_at) WHERE id = ?1`)
      .bind(id, status, error ? clip(error) : null, now, nextAt ?? null);

  for (const d of deliveries) {
    try {
      const hook = hooks.get(d.webhook_id);
      if (!hook || hook.active !== 1) {
        await finish(d.id, 'failed', 'The webhook was deleted or switched off.').run();
        summary.failed++;
        continue;
      }

      if (!secrets.has(hook.id)) {
        try { secrets.set(hook.id, await decryptToken(hook.secret, env.ENCRYPTION_KEY)); }
        catch { secrets.set(hook.id, null); console.error(`vane-cron: could not decrypt the signing secret of webhook ${hook.id} (wrong ENCRYPTION_KEY?)`); }
      }
      const secret = secrets.get(hook.id);
      if (!secret) { await finish(d.id, 'failed', 'Could not read the signing secret.').run(); summary.failed++; continue; }

      const post = d.post_id ? await loadPostPublic(env, d.post_id) : null;
      if (!post) { await finish(d.id, 'failed', 'The post no longer exists.').run(); summary.failed++; continue; }

      const payload: EventPayload = { id: `evt_${d.id}`, type: d.event as EventPayload['type'], createdAt: d.created_at, data: { post } };
      const res = await sendWebhook(hook.url, secret, payload);

      if (res.ok) {
        await env.DB.batch([
          finish(d.id, 'done', null),
          env.DB.prepare('UPDATE webhooks SET failures = 0, last_status = ?2, last_delivery_at = ?3 WHERE id = ?1').bind(hook.id, res.status, now),
        ]);
        summary.delivered++;
      } else if (res.status === 410) {
        // "Gone": the receiver says it will never want these again. Switch it off at once.
        await env.DB.batch([
          finish(d.id, 'failed', res.error ?? 'HTTP 410'),
          env.DB.prepare(`UPDATE webhooks SET active = 0, disabled_reason = 'The endpoint answered 410 Gone.', last_status = 410, last_delivery_at = ?2 WHERE id = ?1`).bind(hook.id, now),
        ]);
        summary.failed++;
      } else if (d.attempts < MAX_DELIVERY_ATTEMPTS) {
        await env.DB.batch([
          finish(d.id, 'pending', res.error ?? 'Delivery failed', now + RETRY_DELAYS[d.attempts - 1]),
          env.DB.prepare('UPDATE webhooks SET last_status = ?2, last_delivery_at = ?3 WHERE id = ?1').bind(hook.id, res.status, now),
        ]);
        summary.retried++;
      } else {
        // Out of attempts: this delivery is lost, and the webhook is one step closer to being switched off.
        await env.DB.batch([
          finish(d.id, 'failed', `${res.error ?? 'Delivery failed'} (gave up after ${d.attempts} attempts)`),
          env.DB
            .prepare(
              `UPDATE webhooks SET failures = failures + 1, last_status = ?2, last_delivery_at = ?3,
                 active = CASE WHEN failures + 1 >= ?4 THEN 0 ELSE active END,
                 disabled_reason = CASE WHEN failures + 1 >= ?4 THEN 'Too many failed deliveries. Fix the endpoint, then press Test to switch it back on.' ELSE disabled_reason END
               WHERE id = ?1`,
            )
            .bind(hook.id, res.status, now, DISABLE_AFTER_FAILURES),
        ]);
        summary.failed++;
      }
    } catch (err) {
      // One bad delivery must never block the others; it goes back to 'pending' and is tried again next minute.
      console.error(`vane-cron: unexpected error on webhook delivery ${d.id}:`, err instanceof Error ? err.message : 'unknown');
      await finish(d.id, 'pending', 'Unexpected internal error.', now + 60).run().catch(() => undefined);
    }
  }

  console.log(`vane-cron webhooks: ${JSON.stringify(summary)}`);
  return summary;
}
