/**
 * POST /api/auth/verify  { email, code, purpose: 'signup' | 'login' }  → session cookie
 *
 *   signup  creates the account from the sign-up that /api/auth/register parked (201)
 *   login   finishes a sign-in that /api/auth/login held back after 3+ days away (200);
 *           every older session of that user is ended, because none of them was used for 3+ days
 *
 * Wrong, expired and used-up codes get 400 / 410 / 404 (see emailcode.ts); the page tells them apart.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env, UserPublic } from '../../../types';
import { markSeen } from '../lib/activity';
import { consumeCode } from '../lib/emailcode';
import { crossOriginViolation, EMAIL_RE, fail, isRecord, json, methodNotAllowed, readJson } from '../lib/http';
import { emailConfigured } from '../lib/mail';
import { createSession, purgeExpired, revokeSessions, SESSION_TTL_SECONDS, sessionCookie } from '../lib/session';
import { createUser } from '../lib/users';
import { logAttempt } from '../lib/attempts';
import { recordAttribution } from '../lib/attribution';
import { recordAgeConfirmed } from '../lib/age';

const CODE_RE = /^\d{6}$/;

interface PendingSignup { passwordHash: string; name: string | null; timezone: string; visitorId: string | null }

function readPending(raw: string | null): PendingSignup | null {
  try {
    const p: unknown = JSON.parse(raw ?? '');
    if (isRecord(p) && typeof p.passwordHash === 'string' && typeof p.timezone === 'string' && (p.name === null || typeof p.name === 'string')) {
      return { passwordHash: p.passwordHash, name: p.name, timezone: p.timezone, visitorId: typeof p.visitorId === 'string' ? p.visitorId : null };
    }
  } catch {
    // fall through: unreadable payload
  }
  return null;
}

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
  const code = typeof body.code === 'string' ? body.code.replace(/\s+/g, '') : '';
  if (!CODE_RE.test(code)) return fail(400, 'Enter the 6-digit code.');

  const used = await consumeCode(env, request, email, purpose, code);
  if (!used.ok) return used.response;

  if (purpose === 'signup') {
    const pending = readPending(used.payload);
    if (!pending) {
      console.error('pending sign-up is unreadable');
      return fail(500, 'Could not create the account. Please start again.');
    }
    const id = crypto.randomUUID();
    const created = await createUser(env, { id, email, passwordHash: pending.passwordHash, name: pending.name, timezone: pending.timezone });
    if (!created.ok) {
      return created.taken
        ? fail(409, 'An account with this email already exists. Try signing in.')
        : fail(500, 'Could not create the account. Please try again.');
    }
    await recordAgeConfirmed(env, id);   // register.ts only parks a sign-up after the date of birth passed
    await markSeen(env, id);
    await logAttempt(env, request, { kind: 'register', ok: true, email });
    await recordAttribution(env, request, id, pending.visitorId);
    const token = await createSession(env, request, id);
    const user: UserPublic = { id, email, name: pending.name, timezone: pending.timezone };
    return json({ ok: true, user }, 201, { 'Set-Cookie': sessionCookie(request, token, SESSION_TTL_SECONDS) });
  }

  const user = await env.DB
    .prepare('SELECT id, email, name, timezone FROM users WHERE email = ?1')
    .bind(email)
    .first<UserPublic>();
  if (!user) return fail(401, 'Please sign in again.');

  await revokeSessions(env, user.id);
  await purgeExpired(env);
  await markSeen(env, user.id);
  await logAttempt(env, request, { kind: 'login', ok: true, email });
  const token = await createSession(env, request, user.id);
  return json({ ok: true, user }, 200, { 'Set-Cookie': sessionCookie(request, token, SESSION_TTL_SECONDS) });
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('POST');
