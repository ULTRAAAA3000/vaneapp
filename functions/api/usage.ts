/** GET /api/usage → plan, quota and what has been used (for the dashboard). */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../types';
import { requireUser } from './lib/auth';
import { json, methodNotAllowed } from './lib/http';
import { loadSubscription, usageSummary } from './lib/usage';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  const sub = await loadSubscription(env, auth.userId);
  return json({ ok: true, usage: await usageSummary(env, auth.userId, sub) });
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET');
