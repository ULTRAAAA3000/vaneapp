/**
 * POST /api/auth/reset  { email, code, password }  -> 200 { ok }
 * Sets a new password with the code from /api/auth/forgot, ends every session of the account and lifts the sign-in lock.
 * It does NOT sign the person in: they sign in with the new password.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { crossOriginViolation, fail, isRecord, methodNotAllowed, readJson } from '../lib/http';
import { confirmPasswordReset } from '../lib/passwordreset';

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const xo = crossOriginViolation(request);
  if (xo) return xo;
  const parsed = await readJson(request, 2048);
  if (!parsed.ok) return parsed.response;
  if (!isRecord(parsed.data)) return fail(400, 'Body must be a JSON object');
  return confirmPasswordReset(env, request, parsed.data.email, parsed.data.code, parsed.data.password);
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('POST');
