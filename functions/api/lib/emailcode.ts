/**
 * 6-digit email codes: confirming a sign-up, and the "you were away" check at sign-in.
 *
 *  - The code is random (rejection-sampled, so no digit is more likely than another) and is stored
 *    only as an HMAC, never in clear.
 *  - 10 minutes to use it; 5 wrong guesses per code. A guess is paid for by ONE atomic UPDATE before
 *    the code is even compared, so parallel requests can't squeeze out extra tries.
 *  - A new code at most every 60 s, and at most 5 mails per address and 20 per network per hour.
 *  - A row outlives its code by an hour, so "Resend" still works after expiry; success deletes it.
 */
import type { Env, VerifyChallenge, VerifyPurpose } from '../../../types';
import { toB64Url } from './encoding';
import { fail, json, safeEqualStrings } from './http';
import { codeMail, sendMail } from './mail';
import { bump, clientIp, retryAfter } from './throttle';

export const CODE_TTL_SECONDS = 10 * 60;
export const RESEND_COOLDOWN_SECONDS = 60;
export const MAX_WRONG_GUESSES = 5;
const KEEP_AFTER_EXPIRY_SECONDS = 3600;
const MAX_MAILS_PER_ADDRESS = 5;
const MAX_MAILS_PER_IP = 20;
const MAIL_WINDOW = 3600;
const MAX_BAD_CODES_PER_IP = 30;
const BAD_CODE_WINDOW = 15 * 60;
const MIN_SECRET_LEN = 32;

const enc = new TextEncoder();

/** 000000–999999, every value equally likely. */
export function generateCode(): string {
  const limit = 4_294_000_000; // the largest multiple of 1,000,000 below 2^32: discarding the rest avoids modulo bias
  const buf = new Uint32Array(1);
  do {
    crypto.getRandomValues(buf);
  } while (buf[0] >= limit);
  return String(buf[0] % 1_000_000).padStart(6, '0');
}

async function hashCode(secret: string, email: string, purpose: VerifyPurpose, code: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${purpose}\n${email}\n${code}`));
  return toB64Url(new Uint8Array(sig));
}

function secretOf(env: Env): string | null {
  if (env.JWT_SECRET && env.JWT_SECRET.length >= MIN_SECRET_LEN) return env.JWT_SECRET;
  console.error('JWT_SECRET is missing or shorter than 32 characters');
  return null;
}

const notConfigured = (): Response => fail(500, 'Server is not configured correctly');
const tooMany = (wait: number, error: string): Response =>
  json({ ok: false, error, retryAfter: wait }, 429, { 'Retry-After': String(wait) });

// ───────────────────────── send ─────────────────────────
export type Issued = { ok: true; challenge: VerifyChallenge } | { ok: false; response: Response };

/**
 * Creates a fresh code for (email, purpose) and emails it. Any earlier code for the same pair stops working.
 *   payload          signup only: the pending sign-up, kept until the code is entered
 *   requireExisting  resend: only when a code was already issued for this pair (so it can't start a new flow)
 */
export async function issueCode(
  env: Env,
  request: Request,
  email: string,
  purpose: VerifyPurpose,
  opts: { payload?: string; requireExisting?: boolean } = {},
): Promise<Issued> {
  const secret = secretOf(env);
  if (!secret) return { ok: false, response: notConfigured() };
  const now = Math.floor(Date.now() / 1000);

  const row = await env.DB
    .prepare('SELECT created_at FROM email_verifications WHERE email = ?1 AND purpose = ?2')
    .bind(email, purpose)
    .first<{ created_at: number }>();
  if (!row && opts.requireExisting) return { ok: false, response: fail(404, 'Nothing to resend. Start again.') };
  if (row && row.created_at + RESEND_COOLDOWN_SECONDS > now) {
    const wait = row.created_at + RESEND_COOLDOWN_SECONDS - now;
    return { ok: false, response: tooMany(wait, `Please wait ${wait} s before asking for another code.`) };
  }

  const emailKey = `mail:em:${email}`;
  const ipKey = `mail:ip:${clientIp(request)}`;
  const wait = Math.max(await retryAfter(env, emailKey, MAX_MAILS_PER_ADDRESS), await retryAfter(env, ipKey, MAX_MAILS_PER_IP));
  if (wait) return { ok: false, response: tooMany(wait, `Too many codes requested. Try again in ${Math.ceil(wait / 60)} min.`) };
  await bump(env, emailKey, MAIL_WINDOW); // counted before sending: a failing mail provider must not be hammered either
  await bump(env, ipKey, MAIL_WINDOW);

  const code = generateCode();
  const codeHash = await hashCode(secret, email, purpose, code);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM email_verifications WHERE expires_at <= ?1').bind(now - KEEP_AFTER_EXPIRY_SECONDS),
    env.DB
      .prepare(
        `INSERT INTO email_verifications (email, purpose, code_hash, payload, attempts, created_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6)
         ON CONFLICT(email, purpose) DO UPDATE SET
           code_hash = ?3, payload = COALESCE(?4, payload), attempts = 0, created_at = ?5, expires_at = ?6`,
      )
      .bind(email, purpose, codeHash, opts.payload ?? null, now, now + CODE_TTL_SECONDS),
  ]);

  if (!(await sendMail(env, codeMail(email, code, purpose, CODE_TTL_SECONDS / 60, new URL(request.url).origin)))) {
    await env.DB.prepare('DELETE FROM email_verifications WHERE email = ?1 AND purpose = ?2').bind(email, purpose).run();
    return { ok: false, response: fail(502, "We couldn't send the email. Check the address and try again.") };
  }
  return { ok: true, challenge: { email, purpose, expiresIn: CODE_TTL_SECONDS, resendIn: RESEND_COOLDOWN_SECONDS } };
}

// ───────────────────────── check ─────────────────────────
export type Consumed = { ok: true; payload: string | null } | { ok: false; response: Response };

/** Why an UPDATE found nothing to guess against: there is no code, it expired, or it ran out of tries. */
async function unusable(env: Env, email: string, purpose: VerifyPurpose, now: number): Promise<Response> {
  const row = await env.DB
    .prepare('SELECT expires_at FROM email_verifications WHERE email = ?1 AND purpose = ?2')
    .bind(email, purpose)
    .first<{ expires_at: number }>();
  if (!row) return fail(404, 'No code is waiting for this email. Start again.');
  if (row.expires_at <= now) return fail(410, 'This code has expired. Ask for a new one.');
  return fail(410, 'Too many wrong tries. Ask for a new code.');
}

/** Checks the code and, when it is right, uses it up (one success per code, even under parallel requests). */
export async function consumeCode(env: Env, request: Request, email: string, purpose: VerifyPurpose, code: string): Promise<Consumed> {
  const secret = secretOf(env);
  if (!secret) return { ok: false, response: notConfigured() };
  const now = Math.floor(Date.now() / 1000);

  const ipKey = `verify:ip:${clientIp(request)}`;
  const wait = await retryAfter(env, ipKey, MAX_BAD_CODES_PER_IP);
  if (wait) return { ok: false, response: tooMany(wait, `Too many wrong codes. Try again in ${Math.ceil(wait / 60)} min.`) };

  // Pay for the guess first, atomically: at most MAX_WRONG_GUESSES requests can ever get past this line per code.
  const row = await env.DB
    .prepare(
      `UPDATE email_verifications SET attempts = attempts + 1
        WHERE email = ?1 AND purpose = ?2 AND attempts < ?3 AND expires_at > ?4
        RETURNING code_hash, payload, attempts`,
    )
    .bind(email, purpose, MAX_WRONG_GUESSES, now)
    .first<{ code_hash: string; payload: string | null; attempts: number }>();
  if (!row) return { ok: false, response: await unusable(env, email, purpose, now) };

  if (!safeEqualStrings(await hashCode(secret, email, purpose, code), row.code_hash)) {
    await bump(env, ipKey, BAD_CODE_WINDOW);
    const left = MAX_WRONG_GUESSES - row.attempts;
    return {
      ok: false,
      response: left > 0 ? fail(400, `That code is not right. ${left} ${left === 1 ? 'try' : 'tries'} left.`) : fail(410, 'Too many wrong tries. Ask for a new code.'),
    };
  }

  // Of two parallel requests that both hold the right code, only the one whose DELETE removes the row wins.
  const used = await env.DB
    .prepare('DELETE FROM email_verifications WHERE email = ?1 AND purpose = ?2 AND code_hash = ?3')
    .bind(email, purpose, row.code_hash)
    .run();
  if ((used.meta?.changes ?? 0) !== 1) return { ok: false, response: fail(409, 'This code was already used.') };
  return { ok: true, payload: row.payload };
}
