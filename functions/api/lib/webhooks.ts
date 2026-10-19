/**
 * Webhooks: Vane calls YOUR https URL when one of your posts reaches a final state.
 *
 *   post.sent        it was published
 *   post.failed      it could not be published (the reason is in `data.post.error`)
 *   post.cancelled   it was cancelled before it was sent
 *
 * A delivery is a POST with a JSON body:
 *   { "id": "evt_<id>", "type": "post.sent", "createdAt": 1790000000, "data": { "post": { … } } }
 * and these headers:
 *   Vane-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" with your signing secret>
 *   Vane-Event: post.sent         Vane-Delivery: evt_<id>         User-Agent: Vane-Webhooks/1.0
 *
 * Verify it: recompute the HMAC over `${t}.${rawBody}`, compare in constant time, and reject a `t` more than 5 minutes old
 * (replay protection). Deliveries are AT LEAST ONCE (a timeout is retried), so dedupe on `id`.
 * Any 2xx answer is a success; anything else is retried 1 min, 5 min, 15 min, 1 h, 6 h later (6 attempts in all).
 * Redirects are NOT followed. After 10 consecutive deliveries that failed for good the webhook is switched off.
 *
 * The rows of the outbox (webhook_deliveries) are written in the same D1 batch as the status change that causes them
 * (see enqueueWebhookEvent), and sent by the cron worker (worker/src/webhooks.ts). This file is shared by both sides.
 */
import type { D1PreparedStatement } from '@cloudflare/workers-types';
import type { Env, WebhookEvent, WebhookPublic } from '../../../types';
import { randomBase62 } from './apikeys';

export const WEBHOOK_EVENTS: readonly WebhookEvent[] = ['post.sent', 'post.failed', 'post.cancelled'];
export const MAX_WEBHOOKS_PER_USER = 5;
/** After this many consecutive deliveries that failed for good, the webhook is switched off. */
export const DISABLE_AFTER_FAILURES = 10;
/** Seconds to wait after attempt N failed (index N-1): 1 min, 5 min, 15 min, 1 h; the 6th failure is final. */
export const RETRY_DELAYS = [60, 300, 900, 3600] as const;
export const MAX_DELIVERY_ATTEMPTS = RETRY_DELAYS.length + 2;
export const DELIVERY_TIMEOUT_MS = 8000;
const SECRET_RANDOM_LEN = 32;

// ───────────────────────── url ─────────────────────────

const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa', '.intranet', '.corp'];
/** Our own hosts: a webhook that calls back into Vane could be used to reach its internals. */
const OWN_HOSTS = ['vaneapp.dev'];

export type UrlCheck = { ok: true; url: string } | { ok: false; error: string };

/**
 * A webhook URL must be https, on the default port, on a public DOMAIN NAME (no IP addresses, no localhost, no internal
 * names, no credentials). Cloudflare Workers cannot reach private networks anyway; this keeps the product honest and
 * gives the owner a clear message. `devMode` (WEBHOOK_DEV_MODE=1, local .dev.vars only) additionally allows http://localhost.
 */
export function validateWebhookUrl(raw: unknown, devMode = false): UrlCheck {
  const bad = (error: string): UrlCheck => ({ ok: false, error });
  if (typeof raw !== 'string' || !raw.trim()) return bad('url is required');
  if (raw.length > 2048) return bad('url is too long (max 2048 characters)');

  let u: URL;
  try { u = new URL(raw.trim()); } catch { return bad('url is not a valid URL'); }

  const host = u.hostname.toLowerCase();
  if (devMode && (host === 'localhost' || host === '127.0.0.1') && (u.protocol === 'http:' || u.protocol === 'https:')) {
    return { ok: true, url: u.toString() };
  }

  if (u.protocol !== 'https:') return bad('url must start with https://');
  if (u.username || u.password) return bad('url must not contain a username or password');
  if (u.port && u.port !== '443') return bad('only the default HTTPS port (443) is allowed');
  if (host.includes(':') || /^[0-9.]+$/.test(host)) return bad('use a domain name, not an IP address');
  if (!host.includes('.') || host === 'localhost' || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    return bad('url must point to a public domain name');
  }
  if (!/^[a-z][a-z0-9-]*$/.test(host.split('.').pop() ?? '')) return bad('url must point to a public domain name');
  if (OWN_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return bad('a webhook cannot point back at Vane');
  return { ok: true, url: u.toString() };
}

// ───────────────────────── secret and signature ─────────────────────────

export const generateWebhookSecret = (): { secret: string; hint: string } => {
  const random = randomBase62(SECRET_RANDOM_LEN);
  return { secret: `whsec_${random}`, hint: random.slice(-4) };
};
export const displaySecret = (hint: string): string => `whsec_••••${hint}`;

const toHex = (buf: ArrayBuffer): string => Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');

/** `t=<timestamp>,v1=<hex>`: the HMAC-SHA256 of "<timestamp>.<body>" under the webhook's secret. */
export async function signWebhook(secret: string, timestamp: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`));
  return `t=${timestamp},v1=${toHex(mac)}`;
}

// ───────────────────────── row ⇄ public ─────────────────────────

export interface WebhookRow {
  id: string;
  user_id: string;
  url: string;
  events: string;
  secret: string;
  hint: string;
  active: number;
  failures: number;
  last_status: number | null;
  last_delivery_at: number | null;
  disabled_reason: string | null;
  created_at: number;
}

export const parseEvents = (stored: string): WebhookEvent[] =>
  stored.split(',').filter((e): e is WebhookEvent => (WEBHOOK_EVENTS as readonly string[]).includes(e));

export const webhookToPublic = (r: WebhookRow): WebhookPublic => ({
  id: r.id,
  url: r.url,
  events: parseEvents(r.events),
  active: r.active === 1,
  secretHint: displaySecret(r.hint),
  failures: r.failures,
  lastStatus: r.last_status,
  lastDeliveryAt: r.last_delivery_at,
  disabledReason: r.disabled_reason,
  createdAt: r.created_at,
});

/** The columns that are safe to select for a list: `secret` (the ciphertext) is never part of it. */
export const WEBHOOK_PUBLIC_COLUMNS = 'id, user_id, url, events, hint, active, failures, last_status, last_delivery_at, disabled_reason, created_at';

// ───────────────────────── the outbox ─────────────────────────

/**
 * A statement that queues `event` for every ACTIVE webhook of the post's owner that subscribed to it.
 * Put it in the same batch as the status change it reports. `onlyIfChanged` makes it conditional on the previous
 * statement of the batch (the guarded UPDATE) having changed a row, so an event is never queued for a change that lost a race.
 */
export function enqueueWebhookEvent(db: Env['DB'], postId: string, event: WebhookEvent, now: number, onlyIfChanged = false): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO webhook_deliveries (id, webhook_id, event, post_id, status, attempts, next_attempt_at, created_at)
       SELECT lower(hex(randomblob(16))), w.id, ?2, p.id, 'pending', 0, ?3, ?3
         FROM posts p JOIN webhooks w ON w.user_id = p.user_id AND w.active = 1
        WHERE p.id = ?1 AND instr(',' || w.events || ',', ',' || ?2 || ',') > 0 ${onlyIfChanged ? 'AND changes() > 0' : ''}`,
    )
    .bind(postId, event, now);
}

/**
 * Queues `post.cancelled` for every post of `channelId` that a bulk
 *   UPDATE posts SET status = 'cancelled', error = <reason>, updated_at = <now> WHERE channel_id = … AND status = 'scheduled'
 * has just cancelled (e.g. Threads access was removed). Put it right after that UPDATE, in the same batch.
 */
export function enqueueCancelledForChannel(db: Env['DB'], channelId: string, reason: string, now: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO webhook_deliveries (id, webhook_id, event, post_id, status, attempts, next_attempt_at, created_at)
       SELECT lower(hex(randomblob(16))), w.id, 'post.cancelled', p.id, 'pending', 0, ?3, ?3
         FROM posts p JOIN webhooks w ON w.user_id = p.user_id AND w.active = 1 AND instr(',' || w.events || ',', ',post.cancelled,') > 0
        WHERE p.channel_id = ?1 AND p.status = 'cancelled' AND p.updated_at = ?3 AND p.error = ?2`,
    )
    .bind(channelId, reason, now);
}

// ───────────────────────── sending ─────────────────────────

export interface EventPayload {
  id: string;
  type: WebhookEvent | 'ping';
  createdAt: number;
  data: Record<string, unknown>;
}

export interface SendResult {
  ok: boolean;
  /** HTTP status, 0 when the endpoint did not answer */
  status: number;
  error?: string;
  durationMs: number;
}

/** One signed POST. Never throws, never follows a redirect, gives up after 8 seconds. */
export async function sendWebhook(url: string, secret: string, payload: EventPayload): Promise<SendResult> {
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Vane-Webhooks/1.0',
        'Vane-Event': payload.type,
        'Vane-Delivery': payload.id,
        'Vane-Signature': await signWebhook(secret, timestamp, body),
      },
      body,
    });
    // We only need the status: don't hold the connection open for a body.
    await res.body?.cancel().catch(() => undefined);
    const durationMs = Date.now() - started;
    if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status, durationMs };
    if (res.status >= 300 && res.status < 400) return { ok: false, status: res.status, error: `Answered with a redirect (${res.status}); redirects are not followed.`, durationMs };
    return { ok: false, status: res.status, error: `Answered with HTTP ${res.status}.`, durationMs };
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { ok: false, status: 0, error: timedOut ? `No answer within ${DELIVERY_TIMEOUT_MS / 1000} seconds.` : 'Could not connect to the URL.', durationMs: Date.now() - started };
  }
}

// ───────────────────────── safe rollout ─────────────────────────

let tablesKnown = false;
/**
 * Are the webhook tables in the database yet? The code can be deployed before `npm run db:remote` is run; until then the
 * paths that CHANGE posts (cancel, the cron worker) must keep working and simply not queue events.
 * A positive answer is cached for the life of the isolate (tables never go away); a negative one is asked again.
 */
export async function webhooksTablesExist(db: Env['DB']): Promise<boolean> {
  if (tablesKnown) return true;
  try {
    const row = await db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('webhooks', 'webhook_deliveries')").first<{ n: number }>();
    tablesKnown = (row?.n ?? 0) === 2;
  } catch {
    tablesKnown = false;
  }
  return tablesKnown;
}
