/**
 * POST /api/auth/age  { birthDate: 'YYYY-MM-DD' }
 *   → 200 + a 30-minute cookie that lets this browser create an account with GitHub / Google
 *   → 403 + a day-long block cookie when the person is under 16
 * The date is checked here and thrown away.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { ageOf, blockCookie, isBlockedMinor, MIN_AGE, NEED_BIRTH, parseBirth, proofCookie, TOO_YOUNG } from '../lib/age';
import { crossOriginViolation, fail, isRecord, json, methodNotAllowed, readJson } from '../lib/http';

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const xo = crossOriginViolation(request);
  if (xo) return xo;
  if (isBlockedMinor(request)) return fail(403, TOO_YOUNG);
  const parsed = await readJson(request, 512);
  if (!parsed.ok) return parsed.response;
  if (!isRecord(parsed.data)) return fail(400, 'Body must be a JSON object');
  const birth = parseBirth(parsed.data.birthDate);
  if (!birth) return fail(400, NEED_BIRTH);
  if (ageOf(birth) < MIN_AGE) return fail(403, TOO_YOUNG, { 'Set-Cookie': blockCookie(request) });
  return json({ ok: true }, 200, { 'Set-Cookie': await proofCookie(env, request) });
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('POST');
