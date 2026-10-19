/** POST /api/admin/logout → ends the admin session and clears the cookie */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { adminCookie, audit, destroyAdminSession, readAdminToken } from '../lib/admin';
import { crossOriginViolation, json, methodNotAllowed } from '../lib/http';

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const xo = crossOriginViolation(request);
  if (xo) return xo;
  const token = readAdminToken(request);
  if (token) {
    await destroyAdminSession(env, token);
    await audit(env, request, 'admin.logout');
  }
  return json({ ok: true }, 200, { 'Set-Cookie': adminCookie(request, '', 0) });
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('POST');
