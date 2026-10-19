/**
 * Minimal bearer-token auth (HS256 JWT) built on Web Crypto.
 *
 * Every protected route starts with:
 *     const auth = await requireUser(request, env);
 *     if (!auth.ok) return auth.response;
 *     // auth.userId is now trustworthy
 *
 * Two ways to authenticate:
 *   1. Browser  → HttpOnly session cookie (see session.ts). State-changing requests also
 *                 pass a same-origin (CSRF) check.
 *   2. Scripts  → `Authorization: Bearer <jwt>` (see scripts/dev-token.mjs). Not sent
 *                 automatically by browsers, so CSRF does not apply.
 */
import type { Env } from '../../../types';
import { fromB64Url, toB64Url } from './encoding';
import { stillActive } from './activity';
import { crossOriginViolation, fail } from './http';
import { emailConfigured } from './mail';
import { readSessionToken, userIdFromSession } from './session';

const enc = new TextEncoder();
const dec = new TextDecoder();
const MIN_SECRET_LEN = 32;

export interface JwtPayload {
  sub: string;
  iat: number;
  exp: number;
}

const hmacKey = (secret: string, usage: 'sign' | 'verify') =>
  crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);

export async function signJWT(payload: { sub: string; exp: number; iat?: number }, secret: string): Promise<string> {
  const full: JwtPayload = { iat: Math.floor(Date.now() / 1000), ...payload };
  const head = toB64Url(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = toB64Url(enc.encode(JSON.stringify(full)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), enc.encode(`${head}.${body}`));
  return `${head}.${body}.${toB64Url(new Uint8Array(sig))}`;
}

/** Returns the payload, or null for ANY problem (bad format, bad signature, expired). */
export async function verifyJWT(token: string, secret: string): Promise<JwtPayload | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [h, p, s] = parts;

    const header = JSON.parse(dec.decode(fromB64Url(h)));
    if (header?.alg !== 'HS256') return null; // never trust the token to pick the algorithm

    // subtle.verify compares in constant time
    const valid = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret, 'verify'),
      fromB64Url(s),
      enc.encode(`${h}.${p}`),
    );
    if (!valid) return null;

    const payload = JSON.parse(dec.decode(fromB64Url(p)));
    if (typeof payload?.sub !== 'string' || !payload.sub) return null;
    if (typeof payload.exp !== 'number' || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    return payload as JwtPayload;
  } catch {
    return null;
  }
}

export type AuthResult = { ok: true; userId: string; via: 'session' | 'bearer' } | { ok: false; response: Response };

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export async function requireUser(request: Request, env: Env): Promise<AuthResult> {
  const unauthorized = (msg = 'Authentication required') => ({
    ok: false as const,
    response: fail(401, msg, { 'WWW-Authenticate': 'Bearer' }),
  });

  // ── 1) Bearer JWT (scripts, tests)
  const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '');
  if (bearer) {
    if (!env.JWT_SECRET || env.JWT_SECRET.length < MIN_SECRET_LEN) {
      console.error('JWT_SECRET is missing or shorter than 32 characters');
      return { ok: false, response: fail(500, 'Server is not configured correctly') };
    }
    const payload = await verifyJWT(bearer[1], env.JWT_SECRET);
    if (!payload) return unauthorized('Invalid or expired token');

    // A valid signature for a user that no longer exists must not pass.
    const user = await env.DB
      .prepare('SELECT u.id FROM users u LEFT JOIN user_flags f ON f.user_id = u.id WHERE u.id = ?1 AND COALESCE(f.disabled, 0) = 0')
      .bind(payload.sub)
      .first<{ id: string }>();
    if (!user) return unauthorized('Invalid or expired token');
    return { ok: true, userId: user.id, via: 'bearer' };
  }

  // ── 2) Session cookie (the browser dashboard)
  const token = readSessionToken(request);
  if (!token) return unauthorized();

  if (!SAFE_METHODS.has(request.method.toUpperCase())) {
    const csrf = crossOriginViolation(request);
    if (csrf) return { ok: false, response: csrf };
  }

  const userId = await userIdFromSession(env, token);
  if (!userId) return unauthorized('Session expired. Please sign in again.');

  // Emailed codes on: a session that sat idle for more than 3 days ends here, and signing in again asks for a code.
  if (emailConfigured(env) && !(await stillActive(env, userId))) {
    return unauthorized('It has been a while. Please sign in again.');
  }
  return { ok: true, userId, via: 'session' };
}
