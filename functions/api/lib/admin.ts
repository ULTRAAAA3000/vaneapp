/**
 * Admin authentication, separate from user accounts on purpose:
 *  - credentials are NOT in the code or the database: ADMIN_EMAIL (+ optional ADMIN_USERNAME) and
 *    ADMIN_PASSWORD_HASH (a PBKDF2 hash from `npm run admin:hash`) are Cloudflare secrets;
 *  - its own cookie (SameSite=Strict, 8 h) and its own session table;
 *  - optional ADMIN_ALLOW_IPS (comma list of addresses / CIDR ranges) restricts it to your networks;
 *  - without the secrets set, the admin is simply switched off (there are no default credentials).
 */
import type { Env } from '../../../types';
import { toB64Url } from './encoding';
import { clientOf } from './guard';
import { crossOriginViolation, fail } from './http';
import { inCidr, parseCidr, parseIp, sameIp } from './ipaddr';
import { verifyPassword } from './password';
import { sha256Hex } from './session';

export const ADMIN_COOKIE = 'vane_admin';
export const ADMIN_TTL_SECONDS = 8 * 3600;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export const adminConfigured = (env: Env): boolean => Boolean(env.ADMIN_EMAIL && env.ADMIN_PASSWORD_HASH);

export function adminCookie(request: Request, token: string, maxAge: number): string {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${ADMIN_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure}`;
}

export function readAdminToken(request: Request): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === ADMIN_COOKIE) {
      const v = part.slice(i + 1).trim();
      return TOKEN_RE.test(v) ? v : null;
    }
  }
  return null;
}

/** true when ADMIN_ALLOW_IPS is empty, or the caller matches one of its entries. */
export function adminIpAllowed(env: Env, request: Request): boolean {
  const list = (env.ADMIN_ALLOW_IPS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length) return true;
  const ip = parseIp(clientOf(request).ip);
  if (!ip) return false;
  return list.some((entry) => {
    if (entry.includes('/')) {
      const c = parseCidr(entry);
      return !!c && inCidr(ip, c);
    }
    const one = parseIp(entry);
    return !!one && sameIp(ip, one);
  });
}

/** Always runs the full password hash, so timing doesn't reveal whether the login name matched. */
export async function checkAdminCredentials(env: Env, login: string, password: string): Promise<boolean> {
  const l = login.trim().toLowerCase();
  const nameOk =
    l !== '' && (l === (env.ADMIN_EMAIL ?? '').trim().toLowerCase() || (!!env.ADMIN_USERNAME && l === env.ADMIN_USERNAME.trim().toLowerCase()));
  const passOk = await verifyPassword(password, env.ADMIN_PASSWORD_HASH ?? '');
  return nameOk && passOk;
}

export async function createAdminSession(env: Env, request: Request): Promise<string> {
  const token = toB64Url(crypto.getRandomValues(new Uint8Array(32)));
  const now = Math.floor(Date.now() / 1000);
  const c = clientOf(request);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?1').bind(now),
    env.DB
      .prepare('INSERT INTO admin_sessions (id, ip, user_agent, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)')
      .bind(await sha256Hex(token), c.ip, c.ua, now, now + ADMIN_TTL_SECONDS),
  ]);
  return token;
}

export async function destroyAdminSession(env: Env, token: string): Promise<void> {
  await env.DB.prepare('DELETE FROM admin_sessions WHERE id = ?1').bind(await sha256Hex(token)).run();
}

export type AdminAuth = { ok: true } | { ok: false; response: Response };

/** Every /api/admin/* route except login starts with this. */
export async function requireAdmin(request: Request, env: Env): Promise<AdminAuth> {
  if (!adminConfigured(env)) return { ok: false, response: fail(503, 'The admin panel is not configured on this server.') };
  if (!adminIpAllowed(env, request)) return { ok: false, response: fail(403, 'Not allowed from this network.') };

  const token = readAdminToken(request);
  if (!token) return { ok: false, response: fail(401, 'Sign in required.') };
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB
    .prepare('SELECT id FROM admin_sessions WHERE id = ?1 AND expires_at > ?2')
    .bind(await sha256Hex(token), now)
    .first();
  if (!row) return { ok: false, response: fail(401, 'Session expired. Sign in again.') };

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const xo = crossOriginViolation(request);
    if (xo) return { ok: false, response: xo };
  }
  return { ok: true };
}

export async function audit(env: Env, request: Request, action: string, target?: string | null, detail?: unknown): Promise<void> {
  try {
    await env.DB
      .prepare('INSERT INTO admin_audit (ts, action, target, detail, ip) VALUES (unixepoch(), ?1, ?2, ?3, ?4)')
      .bind(action, target ?? null, detail === undefined ? null : JSON.stringify(detail).slice(0, 2000), clientOf(request).ip)
      .run();
  } catch (err) {
    console.error('audit failed', err instanceof Error ? err.message : 'unknown');
  }
}
