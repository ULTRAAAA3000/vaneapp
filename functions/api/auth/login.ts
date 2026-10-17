/** POST /api/auth/login  { email, password, turnstileToken? } → 200 + session cookie */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env, UserPublic } from '../../../types';
import { burnPasswordCheck, verifyPassword } from '../lib/password';
import { createSession, purgeExpired, SESSION_TTL_SECONDS, sessionCookie } from '../lib/session';
import { bump, clear, clientIp, retryAfter } from '../lib/throttle';
import { crossOriginViolation, fail, isRecord, json, methodNotAllowed, readJson } from '../lib/http';
import { requireHuman } from '../lib/turnstile';
import { guard } from '../lib/guard';
import { logAttempt, maybeAutoBan } from '../lib/attempts';

const WINDOW = 15 * 60;
const MAX_FAILS_PER_EMAIL = 8;
const MAX_FAILS_PER_IP = 30;

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const xo = crossOriginViolation(request);
  if (xo) return xo;

  const parsed = await readJson(request, 4096);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  if (!isRecord(body)) return fail(400, 'Body must be a JSON object');

  // First line of defence against bots. Checked before any throttle or DB work, so bots can neither
  // burn an account's login attempts nor make us hash passwords.
  const blocked = await guard(env, request, 'login', 'login');
  if (blocked) return blocked;
  const human = await requireHuman(env, request, body.turnstileToken);
  if (human) {
    await logAttempt(env, request, { kind: 'login', ok: false, reason: 'human_check' });
    return human;
  }

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!email || !password || email.length > 254 || password.length > 128) {
    return fail(401, 'Invalid email or password.');
  }

  // Brute-force protection: only FAILED attempts count, on both the account and the network.
  const emailKey = `login:em:${email}`;
  const ipKey = `login:ip:${clientIp(request)}`;
  const wait = Math.max(await retryAfter(env, emailKey, MAX_FAILS_PER_EMAIL), await retryAfter(env, ipKey, MAX_FAILS_PER_IP));
  if (wait) {
    await logAttempt(env, request, { kind: 'login', ok: false, reason: 'throttled', email });
    await maybeAutoBan(env, request, 'login');
    return fail(429, `Too many failed attempts. Try again in ${Math.ceil(wait / 60)} min.`, { 'Retry-After': String(wait) });
  }

  const user = await env.DB
    .prepare('SELECT id, email, name, timezone, password_hash FROM users WHERE email = ?1')
    .bind(email)
    .first<{ id: string; email: string; name: string | null; timezone: string; password_hash: string | null }>();

  let valid = false;
  if (user?.password_hash) valid = await verifyPassword(password, user.password_hash);
  else await burnPasswordCheck(password); // same cost whether or not the email exists

  if (!user || !valid) {
    await bump(env, emailKey, WINDOW);
    await bump(env, ipKey, WINDOW);
    await logAttempt(env, request, { kind: 'login', ok: false, reason: user ? 'bad_password' : 'unknown_user', email });
    await maybeAutoBan(env, request, 'login');
    return fail(401, 'Invalid email or password.'); // one message: don't reveal which part was wrong
  }

  const flag = await env.DB.prepare('SELECT disabled FROM user_flags WHERE user_id = ?1').bind(user.id).first<{ disabled: number }>();
  if (flag?.disabled === 1) {
    await logAttempt(env, request, { kind: 'login', ok: false, reason: 'account_disabled', email });
    return fail(403, 'This account has been disabled.');
  }
  await clear(env, emailKey);
  await purgeExpired(env);
  await logAttempt(env, request, { kind: 'login', ok: true, email });
  const token = await createSession(env, request, user.id);
  const out: UserPublic = { id: user.id, email: user.email, name: user.name, timezone: user.timezone };
  return json({ ok: true, user: out }, 200, { 'Set-Cookie': sessionCookie(request, token, SESSION_TTL_SECONDS) });
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('POST');
