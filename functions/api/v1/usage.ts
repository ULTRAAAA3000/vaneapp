/** GET /api/v1/usage → plan, quota, what is left this period (and what extra posts cost). */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { agentLogged } from '../lib/agentlog';
import { requireApiKey } from '../lib/apikeys';
import { json, methodNotAllowed } from '../lib/http';
import { quotaHeaders, usageSummary } from '../lib/usage';

export const onRequestGet: PagesFunction<Env> = agentLogged('usage', async ({ request, env }) => {
  const auth = await requireApiKey(request, env, 'post');
  if (!auth.ok) return auth.response;
  const usage = await usageSummary(env, auth.userId, auth.sub);
  return json({ ok: true, usage }, 200, quotaHeaders(usage));
});

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET');
