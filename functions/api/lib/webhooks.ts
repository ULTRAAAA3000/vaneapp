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
 * A 429 or 503 with a `Retry-After` of N seconds waits at least that long (at most an hour). 410 Gone ends the subscription, and
 * everything still queued for it. Events are written to an outbox table first (`enqueueWebhookEvent`) and sent by the cron worker
 * (`deliverDueWebhooks`), so a slow receiver never delays posting and nothing is lost when a send fails.
 *
 * Fairness: receivers are called in parallel, one at a time per subscription (so a subscription's events stay in order), and a run
 * takes at most PER_SUBSCRIPTION events of one subscription. One slow or dead receiver therefore cannot hold up the others, and a run
 * (at most PER_SUBSCRIPTION x 8 s) always ends well inside the lease, so an overlapping cron run never sends the same event twice.
 */
import type { Env, PostPublic } from '../../../types';
import { loadPostPublic } from '../posts/list';
import { decryptToken } from './crypto';
import { publicHttpsUrl } from './netsafe';

export const WEBHOOK_EVENTS = ['post.published', 'post.failed'] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
export const MAX_SUBSCRIPTIONS_PER_USER = 10;
const BATCH = 20;
const PER_SUBSCRIPTION = 5;
const MAX_RETRY_AFTER = 3600;
const TIMEOUT_MS = 8000;
const RETRY_DELAYS = [60, 300, 1800, 7200, 43200];            // seconds; attempt n+1 waits RETRY_DELAYS[n-1]
const MAX_ATTEMPTS = RETRY_DELAYS.length + 1;
const LEASE_SECONDS = 120;
const KEEP_SECONDS = 7 * 24 * 3600;

/** A receiver address Vane is willing to call (rules in netsafe.ts). Vane's own hosts are never allowed here. */
export const validateWebhookUrl = (v: unknown): string | null => {
  const ok = publicHttpsUrl(v);
  if (!ok) return null;
  // "example.com." is the same server as "example.com": store one spelling so the same address cannot be subscribed twice
  const u = new URL(ok);
  u.hostname = u.hostname.replace(/\.+$/, '');
  return u.toString();
};

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

interface Due { id: string; subscription_id: string; event: string; payload: string; attempts: number; created_at: number; url: string; secret: string }

/** Seconds a receiver asked us to wait (Retry-After as a number; a date is ignored), kept between 0 and an hour. */
export const retryAfterSeconds = (header: string | null): number => {
  const n = header && /^\s*\d{1,9}\s*$/.test(header) ? Number(header) : 0;
  return Math.min(Math.max(n, 0), MAX_RETRY_AFTER);
};

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
          WHERE id IN (SELECT id FROM (
                         SELECT d.id AS id, d.next_attempt_at AS due,
                                ROW_NUMBER() OVER (PARTITION BY d.subscription_id ORDER BY d.next_attempt_at, d.created_at, d.id) AS rn
                           FROM webhook_deliveries d JOIN webhook_subscriptions s ON s.id = d.subscription_id
                          WHERE d.status = 'pending' AND d.next_attempt_at <= ?1 AND s.disabled_at IS NULL)
                        WHERE rn <= ?4 ORDER BY due LIMIT ?3)
          RETURNING id, subscription_id, event, payload, attempts, created_at`,
      )
      .bind(nowSec, LEASE_SECONDS, BATCH, PER_SUBSCRIPTION)
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

  // One chain per subscription (its events stay in order), all chains at once.
  const chains = new Map<string, Due[]>();
  for (const d of due) chains.set(d.subscription_id, [...(chains.get(d.subscription_id) ?? []), d]);

  await Promise.all([...chains.values()].map(async (rows) => {
    rows.sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1));
    const secret = await decryptToken(rows[0].secret, env.ENCRYPTION_KEY as string).catch(() => null);
    let ended = false;
    for (const d of rows) {
      // The receiver said 410 earlier in this run: the rest of its queue was already closed in the database, so do not call it again.
      if (ended) { out.failed++; continue; }

      let status = 0;
      let error: string | null = null;
      let wait = 0;
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
          if (res.status < 200 || res.status >= 300) {
            error = `The receiver answered HTTP ${res.status}.`;
            if (res.status === 429 || res.status === 503) wait = retryAfterSeconds(res.headers.get('retry-after'));
          }
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
        ended = true;
        await env.DB.batch([
          env.DB.prepare(`UPDATE webhook_deliveries SET status = 'failed', last_error = ?1 WHERE id = ?2`).bind(error, d.id),
          // Everything else waiting for this receiver is closed too, so nothing stays pending for a subscription that no longer runs.
          env.DB.prepare(`UPDATE webhook_deliveries SET status = 'failed', last_error = 'The receiver ended the subscription (HTTP 410).' WHERE subscription_id = ?1 AND status = 'pending' AND id != ?2`).bind(d.subscription_id, d.id),
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
          env.DB.prepare(`UPDATE webhook_deliveries SET next_attempt_at = ?1, last_error = ?2 WHERE id = ?3`).bind(nowSec + Math.max(backoffForAttempt(d.attempts), wait), error, d.id),
          env.DB.prepare('UPDATE webhook_subscriptions SET last_status = ?1 WHERE id = ?2').bind(status, d.subscription_id),
        ]);
      }
    }
  }));
  return out;
}

/** Housekeeping: finished deliveries are kept for a week, and so is anything still queued for a subscription that was switched off. */
export async function purgeOldWebhookDeliveries(env: Pick<Env, 'DB'>, nowSec: number): Promise<void> {
  await env.DB
    .prepare(
      `DELETE FROM webhook_deliveries
        WHERE created_at <= ?1
          AND (status != 'pending' OR subscription_id IN (SELECT id FROM webhook_subscriptions WHERE disabled_at IS NOT NULL))`,
    )
    .bind(nowSec - KEEP_SECONDS)
    .run();
}
