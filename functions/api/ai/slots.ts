import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { requireUser } from '../lib/auth';
import { suggestSlots } from '../lib/aiplus';
import { json, methodNotAllowed } from '../lib/http';
import { nowSeconds } from '../lib/usage';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  const asked = Number(new URL(request.url).searchParams.get('count'));
  const count = Number.isInteger(asked) && asked >= 1 ? Math.min(asked, 14) : 7;
  const tz = (await env.DB.prepare('SELECT timezone FROM users WHERE id = ?1').bind(auth.userId).first<{ timezone: string }>())?.timezone ?? 'UTC';
  return json({ ok: true, ...(await suggestSlots(env, auth.userId, count, nowSeconds(), tz)) });
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET');
