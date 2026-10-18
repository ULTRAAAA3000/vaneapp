/**
 * POST /api/auth/resend  { email, purpose: 'signup' | 'login' }  → 202 { ok, verify }
 *
 * Mails a fresh code (the previous one stops working). Only possible while a sign-up / sign-in is
 * waiting for its code, so it cannot be used to start a flow; the 60 s cooldown and the hourly mail
 * limits live in emailcode.ts.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { issueCode } from '../lib/emailcode';
import { crossOriginViolation, EMAIL_RE, fail, isRecord, json, methodNotAllowed, readJson } from '../lib/http';
import { emailConfigured } from '../lib/mail';

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const xo = crossOriginViolation(request);
  if (xo) return xo;
  if (!emailConfigured(env)) return fail(404, 'Email codes are not turned on.');

  const parsed = await readJson(request, 1024);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  if (!isRecord(body)) return fail(400, 'Body must be a JSON object');

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(email) || email.length > 254) return fail(400, 'Enter a valid email address.');
  const purpose = body.purpose;
  if (purpose !== 'signup' && purpose !== 'login') return fail(400, 'purpose must be "signup" or "login"');

  const issued = await issueCode(env, request, email, purpose, { requireExisting: true });
  if (!issued.ok) return issued.response;
  return json({ ok: true, verify: issued.challenge }, 202);
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('POST');
