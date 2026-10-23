/**
 * Webhooks (REST hooks): Vane calls a URL the user gave when a post is published or fails.
 *
 *   POST  <url>   Content-Type: application/json
 *   Vane-Event: post.published | post.failed
 *   Vane-Delivery: <delivery id>                      same id on every retry: de-duplicate on it
 *   Vane-Signature: t=<unix seconds>,v1=<hex>         HMAC-SHA256 of "<t>.<raw body>" with the subscription secret
 *   {"id":"<delivery id>","type":"post.published","createdAt":"…Z","data":{"post":{…as GET /api/v1/posts/:id…}}}
 *
 * Any 2xx is "delivered". Anything else (or no answer within 8 s) is retried after 1 min, 5 min, 30 min, 2 h, 12 h and then given up.
 * 410 Gone ends the subscription. Events are written to an outbox table first (`enqueueWebhookEvent`) and sent by the cron worker
 * (`deliverDueWebhooks`), so a slow receiver never delays posting and nothing is lost when a send fails.
 */
import type { Env, PostPublic } from '../../../types';
import { loadPostPublic } from '../posts/list';
import { decryptToken } from './crypto';
import { publicHttpsUrl } from './netsafe';

export const WEBHOOK_EVENTS = ['post.published', 'post.failed'] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
export const MAX_SUBSCRIPTIONS_PER_USER = 10;
const BATCH = 20;
const TIMEOUT_MS = 8000;
const RETRY_DELAYS = [60, 300, 1800, 7200, 43200];            // seconds; attempt n+1 waits RETRY_DELAYS[n-1]
const MAX_ATTEMPTS = RETRY_DELAYS.length + 1;
const LEASE_SECONDS = 120;
const KEEP_SECONDS = 7 * 24 * 3600;

/** A receiver address Vane is willing to call (rules in netsafe.ts). Vane's own hosts are never allowed here. */
export const validateWebhookUrl = (v: unknown): string | null => publicHttpsUrl(v);

const hex = (buf: ArrayBuffer): string => Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');

export async function signWebhook(secret: string, timestamp: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return `t=${timestamp},v1=${hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`)))}`;
}

export const newWebhookSecret = (): string => 'whsec_' + hex(crypto.getRandomValues(new Uint8Array(24)).buffer);

type OutboxEnv = Pick<Env, 'DB'> & { ENCRYPTION_KEY?: string };

/**
 * Writes one outbox row for every subscription of the post's owner that wants `event`. Never throws: a webhook problem
 * (including the tables not being created yet) must not disturb posting.
 */
export async function enqueueWebhookEvent(env: OutboxEnv, userId: string, postId: string, event: WebhookEvent, nowSec: number): Promise<number> {
  try {
    const { results: subs } = await env.DB
      .prepare('SELECT id, events FROM webhook_subscriptions WHERE user_id = ?1 AND disabled_at IS NULL')
      .bind(userId)
      .all<{ id: string; events: string }>();
    const wanted = subs.filter((s) => { try { return (JSON.parse(s.events) as string[]).includes(event); } catch { return false; } });
    if (!wanted.length) return 0;
    const post: PostPublic | null = await loadPostPublic(env as Env, postId);
    if (!post) return 0;
    const stmts = wanted.map((s) => {
      const id = crypto.randomUUID();
      const payload = JSON.stringify({ id, type: event, createdAt: new Date(nowSec * 1000).toISOString(), data: { post } });
      return env.DB
        .prepare(`INSERT INTO webhook_deliveries (id, subscription_id, event, payload, next_attempt_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)`)
        .bind(id, s.id, event, payload, nowSec);
    });
    await env.DB.batch(stmts);
    return stmts.length;
  } catch (err) {
    console.error('webhooks: could not queue event', err instanceof Error ? err.message : 'unknown');
    return 0;
  }
}

export const backoffForAttempt = (attempts: number): number => RETRY_DELAYS[Math.min(attempts, RETRY_DELAYS.length) - 1];

interface Due { id: string; subscription_id: string; event: string; payload: string; attempts: number; url: string; secret: string }

/** Sends what is due. Returns how many were delivered / will be retried / were given up. */
export async function deliverDueWebhooks(env: OutboxEnv, nowSec: number): Promise<{ delivered: number; retried: number; failed: number }> {
  const out = { delivered: 0, retried: 0, failed: 0 };
  if (!env.ENCRYPTION_KEY || env.ENCRYPTION_KEY.length < 32) return out;
  let due: Due[];
  try {
    // Claim atomically (the lease pushes next_attempt_at forward, so an overlapping run skips these rows).
    const claimed = await env.DB
      .prepare(
        `UPDATE webhook_deliveries SET attempts = attempts + 1, next_attempt_at = ?1 + ?2
          WHERE id IN (SELECT d.id FROM webhook_deliveries d JOIN webhook_subscriptions s ON s.id = d.subscription_id
                        WHERE d.status = 'pending' AND d.next_attempt_at <= ?1 AND s.disabled_at IS NULL
                        ORDER BY d.next_attempt_at LIMIT ?3)
          RETURNING id, subscription_id, event, payload, attempts`,
      )
      .bind(nowSec, LEASE_SECONDS, BATCH)
      .all<Omit<Due, 'url' | 'secret'>>();
    if (!claimed.results.length) return out;
    const subIds = [...new Set(claimed.results.map((r) => r.subscription_id))];
    const { results: subs } = await env.DB
      .prepare(`SELECT id, url, secret FROM webhook_subscriptions WHERE id IN (${subIds.map((_, i) => `?${i + 1}`).join(',')})`)
      .bind(...subIds)
      .all<{ id: string; url: string; secret: string }>();
    const byId = new Map(subs.map((s) => [s.id, s]));
    due = claimed.results.flatMap((r) => { const s = byId.get(r.subscription_id); return s ? [{ ...r, url: s.url, secret: s.secret }] : []; });
  } catch (err) {
    console.error('webhooks: could not read the outbox', err instanceof Error ? err.message : 'unknown');
    return out;
  }

  const secrets = new Map<string, string | null>();
  for (const d of due) {
    if (!secrets.has(d.subscription_id)) secrets.set(d.subscription_id, await decryptToken(d.secret, env.ENCRYPTION_KEY).catch(() => null));
    const secret = secrets.get(d.subscription_id);
    let status = 0;
    let error: string | null = null;
    if (!secret) {
      error = 'The signing secret could not be read.';
    } else {
      try {
        const ts = Math.floor(Date.now() / 1000);
        const res = await fetch(d.url, {
          method: 'POST',
          redirect: 'manual',   // Workers have no redirect: 'error'; a 3xx is not followed and counts as a failed delivery below
          signal: AbortSignal.timeout(TIMEOUT_MS),
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Vane-Webhooks/1',
            'Vane-Event': d.event,
            'Vane-Delivery': d.id,
            'Vane-Signature': await signWebhook(secret, ts, d.payload),
          },
          body: d.payload,
        });
        status = res.status;
        if (res.status < 200 || res.status >= 300) error = `The receiver answered HTTP ${res.status}.`;
      } catch (e) {
        error = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'The receiver did not answer in time.' : 'Could not connect to the receiver.';
      }
    }

    if (!error) {
      out.delivered++;
      await env.DB.batch([
        env.DB.prepare(`UPDATE webhook_deliveries SET status = 'delivered', last_error = NULL WHERE id = ?1`).bind(d.id),
        env.DB.prepare('UPDATE webhook_subscriptions SET last_status = ?1 WHERE id = ?2').bind(status, d.subscription_id),
      ]);
    } else if (status === 410) {
      out.failed++;
      await env.DB.batch([
        env.DB.prepare(`UPDATE webhook_deliveries SET status = 'failed', last_error = ?1 WHERE id = ?2`).bind(error, d.id),
        env.DB.prepare('UPDATE webhook_subscriptions SET disabled_at = ?1, last_status = 410 WHERE id = ?2').bind(nowSec, d.subscription_id),
      ]);
    } else if (d.attempts >= MAX_ATTEMPTS) {
      out.failed++;
      await env.DB.batch([
        env.DB.prepare(`UPDATE webhook_deliveries SET status = 'failed', last_error = ?1 WHERE id = ?2`).bind(error, d.id),
        env.DB.prepare('UPDATE webhook_subscriptions SET last_status = ?1 WHERE id = ?2').bind(status, d.subscription_id),
      ]);
    } else {
      out.retried++;
      await env.DB.batch([
        env.DB.prepare(`UPDATE webhook_deliveries SET next_attempt_at = ?1, last_error = ?2 WHERE id = ?3`).bind(nowSec + backoffForAttempt(d.attempts), error, d.id),
        env.DB.prepare('UPDATE webhook_subscriptions SET last_status = ?1 WHERE id = ?2').bind(status, d.subscription_id),
      ]);
    }
  }
  return out;
}

/** Housekeeping: finished deliveries are kept for a week. */
export async function purgeOldWebhookDeliveries(env: Pick<Env, 'DB'>, nowSec: number): Promise<void> {
  await env.DB.prepare(`DELETE FROM webhook_deliveries WHERE status != 'pending' AND created_at <= ?1`).bind(nowSec - KEEP_SECONDS).run();
}
