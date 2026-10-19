/**
 * Public API: webhook subscriptions (how Make, Zapier or your own server learn that a post was published or failed).
 *
 *   GET  /api/v1/webhooks        my subscriptions (the secret is never shown again)
 *   POST /api/v1/webhooks        { "url": "https://…", "events": ["post.published", "post.failed"] }  → 201 { webhook, secret }
 *
 * `secret` signs every delivery (header Vane-Signature, see ../../lib/webhooks.ts); it is returned once, keep it.
 * A cpost_test_ key checks the request and answers like a live one, but saves nothing (and no events ever come).
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../../types';
import { requireApiKey } from '../../lib/apikeys';
import { encryptToken } from '../../lib/crypto';
import { fail, failCode, isRecord, json, methodNotAllowed, readJson } from '../../lib/http';
import { MAX_SUBSCRIPTIONS_PER_USER, newWebhookSecret, validateWebhookUrl, WEBHOOK_EVENTS } from '../../lib/webhooks';

interface Row { id: string; url: string; events: string; last_status: number | null; disabled_at: number | null; created_at: number }

export const toPublicWebhook = (r: Row) => ({
  id: r.id,
  url: r.url,
  events: JSON.parse(r.events) as string[],
  lastStatus: r.last_status,
  disabled: r.disabled_at !== null,
  createdAt: r.created_at,
});

const NOT_READY = () => fail(503, 'Webhooks are not enabled on this server yet. The database needs the two webhook tables from schema.sql.');

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireApiKey(request, env, 'post');
  if (!auth.ok) return auth.response;
  try {
    const { results } = await env.DB
      .prepare('SELECT id, url, events, last_status, disabled_at, created_at FROM webhook_subscriptions WHERE user_id = ?1 ORDER BY created_at DESC')
      .bind(auth.userId)
      .all<Row>();
    return json({ ok: true, webhooks: results.map(toPublicWebhook) });
  } catch {
    return NOT_READY();
  }
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireApiKey(request, env, 'post');
  if (!auth.ok) return auth.response;
  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;
  if (!isRecord(parsed.data)) return fail(400, 'Body must be a JSON object');

  const url = validateWebhookUrl(parsed.data.url);
  if (!url) return failCode(400, 'invalid_url', 'url must be a public https address (no IP addresses, no localhost, no port other than 443).');

  let events: string[] = [...WEBHOOK_EVENTS];
  if (parsed.data.events !== undefined) {
    const e = parsed.data.events;
    if (!Array.isArray(e) || !e.length || !e.every((x) => typeof x === 'string' && (WEBHOOK_EVENTS as readonly string[]).includes(x))) {
      return failCode(400, 'invalid_events', `events must be a non-empty list of: ${WEBHOOK_EVENTS.join(', ')}`);
    }
    events = [...new Set(e as string[])];
  }
  if (!env.ENCRYPTION_KEY || env.ENCRYPTION_KEY.length < 32) {
    console.error('ENCRYPTION_KEY is missing or shorter than 32 characters');
    return fail(500, 'Server is not configured correctly');
  }

  const id = crypto.randomUUID();
  const secret = newWebhookSecret();
  const now = Math.floor(Date.now() / 1000);
  const body = { ok: true as const, webhook: { id, url, events, lastStatus: null, disabled: false, createdAt: now }, secret };
  if (auth.key.mode === 'test') return json({ ...body, test: true }, 201, { 'X-Vane-Mode': 'test' });

  try {
    const have = await env.DB.prepare('SELECT url FROM webhook_subscriptions WHERE user_id = ?1').bind(auth.userId).all<{ url: string }>();
    if (have.results.some((r) => r.url === url)) return failCode(409, 'webhook_exists', 'This address is already subscribed. Delete the old subscription first.');
    if (have.results.length >= MAX_SUBSCRIPTIONS_PER_USER) return failCode(409, 'too_many_webhooks', `At most ${MAX_SUBSCRIPTIONS_PER_USER} webhooks per account.`);
    await env.DB
      .prepare('INSERT INTO webhook_subscriptions (id, user_id, url, events, secret, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
      .bind(id, auth.userId, url, JSON.stringify(events), await encryptToken(secret, env.ENCRYPTION_KEY), now)
      .run();
  } catch {
    return NOT_READY();
  }
  return json(body, 201);
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET, POST');
