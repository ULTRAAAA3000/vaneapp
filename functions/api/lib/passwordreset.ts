/**
 * "Forgot password?" (the /reset page): an emailed 6-digit code that lets a person set a new password.
 *
 *   requestPasswordReset  POST /api/auth/forgot  { email }                      -> 202, ALWAYS the same answer
 *   confirmPasswordReset  POST /api/auth/reset   { email, code, password }      -> 200 { ok }
 *
 * What keeps it safe:
 *  - The answer to "forgot" never says whether the address has an account (the same 202 either way, throttles counted before the lookup).
 *  - The code is random, stored only as an HMAC of ("reset", email, code), valid 15 minutes, 5 wrong guesses per code (each guess is paid
 *    for by ONE atomic UPDATE before it is compared), 30 wrong codes per network per 15 minutes. It lives in its own table
 *    (password_resets) and its hash is bound to the purpose, so it can never be used to sign in or to finish a sign-up.
 *  - A new code at most every 60 s, at most 5 mails per address and 20 per network per hour (also when no account exists).
 *  - On success: the new password is hashed, EVERY session of the account is ended, the sign-in lock for that email is lifted so the
 *    person can sign in at once, and a "your password was changed" mail goes to the owner. The person is NOT signed in by the reset.
 *  - Disabled accounts get nothing. A code works once (of two parallel requests with the right code, exactly one wins).
 */
import type { Env } from '../../../types';
import { toB64Url } from './encoding';
import { fail, json, safeEqualStrings } from './http';
import { passwordChangedMail, resetMail, emailConfigured, sendMail } from './mail';
import { hashPassword, MAX_PASSWORD, MIN_PASSWORD } from './password';
import { bump, clear, clientIp, retryAfter } from './throttle';

export const RESET_TTL_SECONDS = 15 * 60;
export const RESET_COOLDOWN_SECONDS = 60;
export const MAX_WRONG_GUESSES = 5;
const MAX_MAILS_PER_ADDRESS = 5;
const MAX_MAILS_PER_IP = 20;
const MAIL_WINDOW = 3600;
const MAX_BAD_CODES_PER_IP = 30;
const BAD_CODE_WINDOW = 15 * 60;
const KEEP_AFTER_EXPIRY_SECONDS = 3600;
const MIN_SECRET_LEN = 32;

const enc = new TextEncoder();
export const RESET_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** 000000-999999, every value equally likely (rejection sampling: no modulo bias). */
function generateCode(): string {
  const limit = 4_294_000_000;
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf); while (buf[0] >= limit);
  return String(buf[0] % 1_000_000).padStart(6, '0');
}

async function hashCode(secret: string, email: string, code: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toB64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`reset\n${email}\n${code}`))));
}

const secretOf = (env: Env): string | null => (env.JWT_SECRET && env.JWT_SECRET.length >= MIN_SECRET_LEN ? env.JWT_SECRET : null);
const tooMany = (wait: number, error: string): Response => json({ ok: false, error, retryAfter: wait }, 429, { 'Retry-After': String(wait) });
const unavailable = (): Response => fail(503, 'Password reset is not available right now. Please try again later.');
const normEmail = (v: unknown): string => (typeof v === 'string' ? v.trim().toLowerCase() : '');

/** An account that may sign in (not disabled). */
async function findUser(env: Env, email: string): Promise<{ id: string } | null> {
  return env.DB
    .prepare(`SELECT u.id AS id FROM users u LEFT JOIN user_flags f ON f.user_id = u.id WHERE u.email = ?1 AND COALESCE(f.disabled, 0) = 0 LIMIT 1`)
    .bind(email)
    .first<{ id: string }>();
}

export async function requestPasswordReset(env: Env, request: Request, rawEmail: unknown): Promise<Response> {
  if (!emailConfigured(env)) return fail(404, 'Password reset by email is not turned on.');
  const email = normEmail(rawEmail);
  if (!RESET_EMAIL_RE.test(email) || email.length > 254) return fail(400, 'Enter a valid email address.');
  const secret = secretOf(env);
  if (!secret) return fail(500, 'Server is not configured correctly');

  try {
    // Counted first, for every address, so the throttle answers the same whether or not an account exists.
    const emailKey = `reset:em:${email}`;
    const ipKey = `reset:ip:${clientIp(request)}`;
    const wait = Math.max(await retryAfter(env, emailKey, MAX_MAILS_PER_ADDRESS), await retryAfter(env, ipKey, MAX_MAILS_PER_IP));
    if (wait) return tooMany(wait, `Too many requests. Try again in ${Math.ceil(wait / 60)} min.`);
    await bump(env, emailKey, MAIL_WINDOW);
    await bump(env, ipKey, MAIL_WINDOW);

    const ok = (): Response => json({ ok: true, expiresIn: RESET_TTL_SECONDS, resendIn: RESET_COOLDOWN_SECONDS }, 202);
    const user = await findUser(env, email);
    if (!user) return ok();

    const now = Math.floor(Date.now() / 1000);
    const row = await env.DB.prepare('SELECT created_at FROM password_resets WHERE email = ?1').bind(email).first<{ created_at: number }>();
    if (row && row.created_at + RESET_COOLDOWN_SECONDS > now) return ok();   // a fresh code was just sent

    const code = generateCode();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM password_resets WHERE expires_at <= ?1').bind(now - KEEP_AFTER_EXPIRY_SECONDS),
      env.DB
        .prepare(
          `INSERT INTO password_resets (email, code_hash, attempts, created_at, expires_at) VALUES (?1, ?2, 0, ?3, ?4)
           ON CONFLICT(email) DO UPDATE SET code_hash = ?2, attempts = 0, created_at = ?3, expires_at = ?4`,
        )
        .bind(email, await hashCode(secret, email, code), now, now + RESET_TTL_SECONDS),
    ]);
    if (!(await sendMail(env, resetMail(email, code, RESET_TTL_SECONDS / 60)))) {
      await env.DB.prepare('DELETE FROM password_resets WHERE email = ?1').bind(email).run();   // no mail, no code to guess
    }
    return ok();
  } catch (err) {
    console.error('password reset request failed', err instanceof Error ? err.message : 'unknown');
    return unavailable();   // e.g. the password_resets table is not in the database yet
  }
}

export async function confirmPasswordReset(env: Env, request: Request, rawEmail: unknown, rawCode: unknown, rawPassword: unknown): Promise<Response> {
  if (!emailConfigured(env)) return fail(404, 'Password reset by email is not turned on.');
  const email = normEmail(rawEmail);
  const code = typeof rawCode === 'string' ? rawCode.replace(/\s+/g, '') : '';
  const password = typeof rawPassword === 'string' ? rawPassword : '';
  if (!RESET_EMAIL_RE.test(email) || email.length > 254) return fail(400, 'Enter a valid email address.');
  if (!/^\d{6}$/.test(code)) return fail(400, 'The code is 6 digits.');
  if (password.length < MIN_PASSWORD) return fail(400, `Password must be at least ${MIN_PASSWORD} characters.`);
  if (password.length > MAX_PASSWORD) return fail(400, `Password must be at most ${MAX_PASSWORD} characters.`);
  const secret = secretOf(env);
  if (!secret) return fail(500, 'Server is not configured correctly');

  try {
    const now = Math.floor(Date.now() / 1000);
    const ipKey = `reset:bad:${clientIp(request)}`;
    const wait = await retryAfter(env, ipKey, MAX_BAD_CODES_PER_IP);
    if (wait) return tooMany(wait, `Too many wrong codes. Try again in ${Math.ceil(wait / 60)} min.`);

    // Pay for the guess first, atomically: at most MAX_WRONG_GUESSES requests can ever get past this line per code.
    const row = await env.DB
      .prepare(`UPDATE password_resets SET attempts = attempts + 1 WHERE email = ?1 AND attempts < ?2 AND expires_at > ?3 RETURNING code_hash, attempts`)
      .bind(email, MAX_WRONG_GUESSES, now)
      .first<{ code_hash: string; attempts: number }>();
    if (!row) return fail(410, 'This code is not valid any more. Ask for a new one.');

    if (!safeEqualStrings(await hashCode(secret, email, code), row.code_hash)) {
      await bump(env, ipKey, BAD_CODE_WINDOW);
      const left = MAX_WRONG_GUESSES - row.attempts;
      return left > 0 ? fail(400, `That code is not right. ${left} ${left === 1 ? 'try' : 'tries'} left.`) : fail(410, 'Too many wrong tries. Ask for a new code.');
    }

    // Of two parallel requests that both hold the right code, only the one whose DELETE removes the row wins.
    const used = await env.DB.prepare('DELETE FROM password_resets WHERE email = ?1 AND code_hash = ?2').bind(email, row.code_hash).run();
    if ((used.meta?.changes ?? 0) !== 1) return fail(409, 'This code was already used.');

    const user = await findUser(env, email);
    if (!user) return fail(410, 'This code is not valid any more. Ask for a new one.');

    const hash = await hashPassword(password);
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET password_hash = ?1 WHERE id = ?2').bind(hash, user.id),
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(user.id),   // every device signs in again with the new password
    ]);
    await clear(env, `login:em:${email}`);                                         // an earlier lock for failed attempts must not keep them out
    await sendMail(env, passwordChangedMail(email, new URL(request.url).origin));  // best effort: the password is already changed
    return json({ ok: true });
  } catch (err) {
    console.error('password reset failed', err instanceof Error ? err.message : 'unknown');
    return unavailable();
  }
}
