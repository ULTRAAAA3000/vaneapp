/**
 * Webhooks for the signed-in user (dashboard / dev JWT). API keys are NOT accepted here; they use /api/v1/webhooks.
 *
 *   GET  /api/webhooks   → my webhooks (the signing secret is never returned)
 *   POST /api/webhooks   → { url, events? } → the new webhook with its SIGNING SECRET (shown once)
 *   DELETE /api/webhooks/:id        (see ./[id].ts)
 *   POST   /api/webhooks/:id/test   sends a ping now (see ./[id]/test.ts)
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { requireUser } from '../lib/auth';
import { failCode, methodNotAllowed, readJson } from '../lib/http';
import { apiAllowed } from '../lib/plans';
import { loadSubscription } from '../lib/usage';
import { createWebhookForUser, listWebhooksForUser } from '../lib/webhookapi';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  return listWebhooksForUser(env, auth.userId);
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;

  // Webhooks belong to the API: a plan without API access cannot add one (the Pro dashboard needs the API Add-on).
  if (!apiAllowed(await loadSubscription(env, auth.userId))) {
    return failCode(403, 'api_not_in_plan', 'Your plan does not include API access. Add the API Add-on to use webhooks.');
  }
  const parsed = await readJson(request, 4096);
  if (!parsed.ok) return parsed.response;
  return createWebhookForUser(env, auth.userId, parsed.data);
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET, POST');
