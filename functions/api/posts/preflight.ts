import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { requireUser } from '../lib/auth';
import { methodNotAllowed, json } from '../lib/http';
import { findProblems } from '../lib/preflight';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  const problems = await findProblems(env, Math.floor(Date.now() / 1000), { userId: auth.userId });
  return json({ ok: true, problems: problems.map(({ userId: _u, ...p }) => p) });
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET');
