/**
 * Public API: webhooks (Vane calls your URL when a post is sent, fails or is cancelled; see lib/webhooks.ts for the format).
 *
 *   GET  /api/v1/webhooks   list
 *   POST /api/v1/webhooks   { "url": "https://…", "events": ["post.sent", …]? }  → the webhook and its signing SECRET (shown once)
 *
 * A test key (cpost_test_…) validates and answers like a live one, but stores nothing (`"test": true`).
 * This is also the "subscribe" call REST-hook tools (Zapier, Make instant triggers) need.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../../types';
import { requireApiKey } from '../../lib/apikeys';
import { methodNotAllowed, readJson } from '../../lib/http';
import { createWebhookForUser, listWebhooksForUser } from '../../lib/webhookapi';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireApiKey(request, env, 'post');
  if (!auth.ok) return auth.response;
  return listWebhooksForUser(env, auth.userId);
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireApiKey(request, env, 'post');
  if (!auth.ok) return auth.response;
  const parsed = await readJson(request, 4096);
  if (!parsed.ok) return parsed.response;
  return createWebhookForUser(env, auth.userId, parsed.data, auth.key.mode === 'test');
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET, POST');
