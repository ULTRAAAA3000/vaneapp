/**
 * POST /api/auth/register  { email, password, name?, timezone?, turnstileToken? }
 *   → 201 + session cookie                         emailed codes off: the account is created right away
 *   → 202 { ok, verify }, NO account yet           emailed codes on: a 6-digit code was mailed; the account is
 *                                                  created by POST /api/auth/verify once the code is entered
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env, UserPublic } from '../../../types';
import { issueCode } from '../lib/emailcode';
import { emailConfigured } from '../lib/mail';
import { hashPassword } from '../lib/password';
import { createSession, SESSION_TTL_SECONDS, sessionCookie } from '../lib/session';
import { bump, clientIp, retryAfter } from '../lib/throttle';
import { crossOriginViolation, EMAIL_RE, fail, isRecord, json, methodNotAllowed, readJson } from '../lib/http';
import { requireHuman } from '../lib/turnstile';
import { createUser } from '../lib/users';

const MIN_PASSWORD = 8;
const MAX_PASSWORD = 128; // also caps the CPU an attacker can make us spend hashing

function validTimezone(tz: unknown): string {
  if (typeof tz !== 'string' || tz.length > 64) return 'UTC';
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const xo = crossOriginViolation(request);
  if (xo) return xo;

  // Hashing is deliberately expensive, so cap sign-ups per IP: 10 per hour.
  const ipKey = `reg:${clientIp(request)}`;
  const wait = await retryAfter(env, ipKey, 10);
  if (wait) return fail(429, 'Too many sign-ups from this network. Try again later.', { 'Retry-After': String(wait) });
  await bump(env, ipKey, 3600);

  const parsed = await readJson(request, 4096);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  if (!isRecord(body)) return fail(400, 'Body must be a JSON object');

  // First line of defence against bots. Checked before any throttle or DB work, so bots can neither
  // burn an account's login attempts nor make us hash passwords.
  const human = await requireHuman(env, request, body.turnstileToken);
  if (human) return human;

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(email) || email.length > 254) return fail(400, 'Enter a valid email address.');

  const password = typeof body.password === 'string' ? body.password : '';
  if (password.length < MIN_PASSWORD) return fail(400, `Password must be at least ${MIN_PASSWORD} characters.`);
  if (password.length > MAX_PASSWORD) return fail(400, `Password must be at most ${MAX_PASSWORD} characters.`);

  const name = typeof body.name === 'string' ? body.name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80) : '';
  const timezone = validTimezone(body.timezone);

  const exists = await env.DB.prepare('SELECT id FROM users WHERE email = ?1').bind(email).first();
  if (exists) return fail(409, 'An account with this email already exists. Try signing in.');

  const passwordHash = await hashPassword(password);

  // Nothing is created yet: the sign-up waits for the code from the email. Mistyped or made-up addresses
  // therefore never become accounts (see verify.ts for the second half).
  if (emailConfigured(env)) {
    const issued = await issueCode(env, request, email, 'signup', {
      payload: JSON.stringify({ passwordHash, name: name || null, timezone }),
    });
    if (!issued.ok) return issued.response;
    return json({ ok: true, verify: issued.challenge }, 202);
  }

  const id = crypto.randomUUID();
  const created = await createUser(env, { id, email, passwordHash, name: name || null, timezone });
  if (!created.ok) {
    return created.taken
      ? fail(409, 'An account with this email already exists. Try signing in.')
      : fail(500, 'Could not create the account. Please try again.');
  }

  const token = await createSession(env, request, id);
  const user: UserPublic = { id, email, name: name || null, timezone };
  return json({ ok: true, user }, 201, { 'Set-Cookie': sessionCookie(request, token, SESSION_TTL_SECONDS) });
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('POST');
