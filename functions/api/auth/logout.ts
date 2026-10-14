/** POST /api/auth/logout → deletes the session server-side and clears the cookie */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { crossOriginViolation, json, methodNotAllowed } from '../lib/http';
import { clearedSessionCookie, destroySession, readSessionToken } from '../lib/session';

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const xo = crossOriginViolation(request);
  if (xo) return xo;

  const token = readSessionToken(request);
  if (token) await destroySession(env, token);
  return json({ ok: true }, 200, { 'Set-Cookie': clearedSessionCookie(request) });
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('POST');
