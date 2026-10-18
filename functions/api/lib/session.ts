/**
 * Server-side sessions.
 *
 * Login creates a random 256-bit token, sends it in an HttpOnly cookie and stores only its
 * SHA-256 in D1. JavaScript on the page can never read the cookie (so XSS can't steal it),
 * and logout genuinely invalidates it.
 */
import type { Env } from '../../../types';
import { toB64Url } from './encoding';

export const SESSION_COOKIE = 'vane_session';
export const SESSION_TTL_SECONDS = 30 * 24 * 3600;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function readSessionToken(request: Request): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === SESSION_COOKIE) {
      const v = part.slice(i + 1).trim();
      return TOKEN_RE.test(v) ? v : null;
    }
  }
  return null;
}

/** `Secure` is set whenever the site runs on https (always, in production). */
export function sessionCookie(request: Request, token: string, maxAge: number): string {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
}

export const clearedSessionCookie = (request: Request): string => sessionCookie(request, '', 0);

export async function createSession(env: Env, request: Request, userId: string): Promise<string> {
  const token = toB64Url(crypto.getRandomValues(new Uint8Array(32)));
  const now = Math.floor(Date.now() / 1000);
  const ua = (request.headers.get('user-agent') ?? '').slice(0, 200);
  await env.DB
    .prepare('INSERT INTO sessions (id, user_id, user_agent, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(await sha256Hex(token), userId, ua, now, now + SESSION_TTL_SECONDS)
    .run();
  return token;
}

export async function destroySession(env: Env, token: string): Promise<void> {
  await env.DB.prepare('DELETE FROM sessions WHERE id = ?1').bind(await sha256Hex(token)).run();
}

/** Ends every session of a user, on every device (used when they come back after being away). */
export async function revokeSessions(env: Env, userId: string): Promise<void> {
  await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(userId).run();
}

/** Returns the user id for a live session, or null. */
export async function userIdFromSession(env: Env, token: string): Promise<string | null> {
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB
    .prepare(
      `SELECT s.user_id FROM sessions s LEFT JOIN user_flags f ON f.user_id = s.user_id
        WHERE s.id = ?1 AND s.expires_at > ?2 AND COALESCE(f.disabled, 0) = 0`,
    )
    .bind(await sha256Hex(token), now)
    .first<{ user_id: string }>();
  return row?.user_id ?? null;
}

/** Housekeeping, run opportunistically on login. */
export async function purgeExpired(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?1').bind(now),
    env.DB.prepare('DELETE FROM rate_limits WHERE reset_at <= ?1').bind(now),
  ]);
}
