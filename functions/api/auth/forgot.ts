/**
 * POST /api/auth/forgot  { email }  -> 202 { ok, expiresIn, resendIn }  (the same answer whether or not the address has an account)
 * Mails a 6-digit code for /reset. 404 when email is not set up on the server (the page hides "Forgot password?" then).
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { crossOriginViolation, fail, isRecord, methodNotAllowed, readJson } from '../lib/http';
import { requestPasswordReset } from '../lib/passwordreset';

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const xo = crossOriginViolation(request);
  if (xo) return xo;
  const parsed = await readJson(request, 1024);
  if (!parsed.ok) return parsed.response;
  if (!isRecord(parsed.data)) return fail(400, 'Body must be a JSON object');
  return requestPasswordReset(env, request, parsed.data.email);
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('POST');
