/**
 * GET /api/v1/me → "is my key valid, and what plan is it on?"  (the call Make / Zapier use to test a connection)
 *
 * Public API (version 1): every route under /api/v1 takes `Authorization: Bearer cpost_live_… | cpost_test_…`.
 * Errors are `{ ok: false, error, code }`; clients should branch on `code`.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { requireApiKey } from '../lib/apikeys';
import { json, methodNotAllowed } from '../lib/http';
import { usageSummary } from '../lib/usage';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireApiKey(request, env, 'post');
  if (!auth.ok) return auth.response;
  const usage = await usageSummary(env, auth.userId, auth.sub);
  return json({
    ok: true,
    key: { name: auth.key.name, scope: auth.key.scope, mode: auth.key.mode },
    plan: usage.plan,
    apiAccess: usage.apiAccess,
  });
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET');
