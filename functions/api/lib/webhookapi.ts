/**
 * Webhook management, shared by the dashboard routes (/api/webhooks, session) and the public API (/api/v1/webhooks, key).
 * Behaviour is identical on both; a test-mode key only changes `dryRun` (create / delete are simulated, nothing is stored).
 */
import type { Env, WebhookEvent } from '../../../types';
import { decryptToken, encryptToken } from './crypto';
import { fail, failCode, isRecord, json, UUID_RE } from './http';
import { bump, retryAfter } from './throttle';
import {
  generateWebhookSecret, MAX_WEBHOOKS_PER_USER, sendWebhook, validateWebhookUrl, webhookToPublic, WEBHOOK_EVENTS, WEBHOOK_PUBLIC_COLUMNS,
  type WebhookRow,
} from './webhooks';

const PING_PER_MINUTE = 10;

export async function listWebhooksForUser(env: Env, userId: string): Promise<Response> {
  // Explicit columns: `secret` (the ciphertext) is never selected.
  const { results } = await env.DB
    .prepare(`SELECT ${WEBHOOK_PUBLIC_COLUMNS} FROM webhooks WHERE user_id = ?1 ORDER BY created_at DESC`)
    .bind(userId)
    .all<WebhookRow>();
  return json({ ok: true, webhooks: results.map(webhookToPublic), max: MAX_WEBHOOKS_PER_USER });
}

export async function createWebhookForUser(env: Env, userId: string, body: unknown, dryRun = false): Promise<Response> {
  if (!isRecord(body)) return fail(400, 'Body must be a JSON object');

  const checked = validateWebhookUrl(body.url, env.WEBHOOK_DEV_MODE === '1');
  if (!checked.ok) return failCode(400, 'invalid_webhook_url', checked.error);

  let events: WebhookEvent[] = [...WEBHOOK_EVENTS];
  if (body.events !== undefined) {
    if (!Array.isArray(body.events) || body.events.length === 0 || !body.events.every((e): e is WebhookEvent => (WEBHOOK_EVENTS as readonly unknown[]).includes(e))) {
      return failCode(400, 'invalid_webhook_events', `events must be a non-empty list of: ${WEBHOOK_EVENTS.join(', ')}`);
    }
    events = [...new Set(body.events)];
  }

  const { secret, hint } = generateWebhookSecret();
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  if (dryRun) {
    // A test key: validated like a live one, answered like one, nothing stored.
    return json({
      ok: true, test: true,
      webhook: webhookToPublic({ id, user_id: userId, url: checked.url, events: events.join(','), hint, active: 1, failures: 0, last_status: null, last_delivery_at: null, disabled_reason: null, created_at: now, secret: '' }),
      secret,
    }, 201, { 'X-Vane-Mode': 'test' });
  }

  if (!env.ENCRYPTION_KEY) return fail(500, 'Webhooks are not configured on this server.');

  const count = await env.DB.prepare('SELECT COUNT(*) AS n, SUM(url = ?2) AS same FROM webhooks WHERE user_id = ?1').bind(userId, checked.url).first<{ n: number; same: number | null }>();
  if ((count?.same ?? 0) > 0) return failCode(409, 'webhook_exists', 'You already have a webhook for this URL.');
  if ((count?.n ?? 0) >= MAX_WEBHOOKS_PER_USER) {
    return failCode(409, 'too_many_webhooks', `You can have up to ${MAX_WEBHOOKS_PER_USER} webhooks. Delete one you no longer use.`);
  }

  try {
    await env.DB
      .prepare('INSERT INTO webhooks (id, user_id, url, events, secret, hint, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
      .bind(id, userId, checked.url, events.join(','), await encryptToken(secret, env.ENCRYPTION_KEY), hint, now)
      .run();
  } catch (err) {
    console.error('webhook insert failed', err instanceof Error ? err.message : 'unknown');
    return fail(500, 'Could not create the webhook. Please try again.');
  }

  return json(
    { ok: true, webhook: webhookToPublic({ id, user_id: userId, url: checked.url, events: events.join(','), hint, active: 1, failures: 0, last_status: null, last_delivery_at: null, disabled_reason: null, created_at: now, secret: '' }), secret },
    201,
  );
}

export async function deleteWebhookForUser(env: Env, userId: string, id: string | undefined, dryRun = false): Promise<Response> {
  if (!id || !UUID_RE.test(id)) return fail(404, 'Webhook not found');
  if (dryRun) {
    const row = await env.DB.prepare('SELECT 1 AS x FROM webhooks WHERE id = ?1 AND user_id = ?2').bind(id, userId).first();
    return row ? json({ ok: true, test: true }) : fail(404, 'Webhook not found');
  }
  // Its queued deliveries go with it. Done explicitly (not left to ON DELETE CASCADE) so it holds on any database setup,
  // and in ONE batch so a webhook is never left half-deleted. The first statement is scoped to MY webhook.
  const [, res] = await env.DB.batch([
    env.DB.prepare('DELETE FROM webhook_deliveries WHERE webhook_id IN (SELECT id FROM webhooks WHERE id = ?1 AND user_id = ?2)').bind(id, userId),
    env.DB.prepare('DELETE FROM webhooks WHERE id = ?1 AND user_id = ?2').bind(id, userId),
  ]);
  return (res.meta?.changes ?? 0) > 0 ? json({ ok: true }) : fail(404, 'Webhook not found');
}

/**
 * Sends a `ping` to the webhook right now and reports what the endpoint answered. A successful ping also switches a
 * webhook that was turned off back on: fix the endpoint, press Test, done.
 */
export async function pingWebhookForUser(env: Env, userId: string, id: string | undefined): Promise<Response> {
  if (!id || !UUID_RE.test(id)) return fail(404, 'Webhook not found');
  if (!env.ENCRYPTION_KEY) return fail(500, 'Webhooks are not configured on this server.');

  const key = `hookping:${userId}`;
  const wait = await retryAfter(env, key, PING_PER_MINUTE);
  if (wait) return failCode(429, 'rate_limited', `Too many test events. Try again in ${wait} seconds.`, { retryAfter: wait }, { 'Retry-After': String(wait) });

  const row = await env.DB.prepare('SELECT id, url, secret FROM webhooks WHERE id = ?1 AND user_id = ?2').bind(id, userId).first<Pick<WebhookRow, 'id' | 'url' | 'secret'>>();
  if (!row) return fail(404, 'Webhook not found');
  await bump(env, key, 60);

  let secret: string;
  try { secret = await decryptToken(row.secret, env.ENCRYPTION_KEY); }
  catch { return fail(500, 'Could not read the signing secret.'); }

  const now = Math.floor(Date.now() / 1000);
  const result = await sendWebhook(row.url, secret, {
    id: `evt_ping_${crypto.randomUUID().replace(/-/g, '')}`,
    type: 'ping',
    createdAt: now,
    data: { message: 'This is a test event from Vane. If you can read it, your endpoint works.' },
  });

  await env.DB
    .prepare(
      `UPDATE webhooks SET last_status = ?2, last_delivery_at = ?3,
         active = CASE WHEN ?4 = 1 THEN 1 ELSE active END,
         failures = CASE WHEN ?4 = 1 THEN 0 ELSE failures END,
         disabled_reason = CASE WHEN ?4 = 1 THEN NULL ELSE disabled_reason END
       WHERE id = ?1`,
    )
    .bind(row.id, result.status, now, result.ok ? 1 : 0)
    .run();

  return json({ ok: true, delivered: result.ok, status: result.status || null, ...(result.error ? { error: result.error } : {}), durationMs: result.durationMs });
}
