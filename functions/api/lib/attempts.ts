/** The sign-in / sign-up attempt log, plus the automatic ban for addresses that abuse it. */
import type { Env } from '../../../types';
import { clientOf, invalidateGuardCache } from './guard';
import { isPrivateIp } from './ipaddr';
import { getSettings } from './settings';

export type AttemptKind = 'login' | 'register' | 'admin_login';

export interface AttemptInput {
  kind: AttemptKind;
  ok: boolean;
  reason?: string | null;
  email?: string | null;
}

/** Best effort: a logging failure must never break signing in. */
export async function logAttempt(env: Env, request: Request, a: AttemptInput): Promise<void> {
  const c = clientOf(request);
  try {
    await env.DB
      .prepare(
        `INSERT INTO auth_attempts (ts, kind, ok, reason, email, ip, country, city, asn, as_org, ua)
         VALUES (unixepoch(), ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
      )
      .bind(a.kind, a.ok ? 1 : 0, a.reason ?? null, a.email ? a.email.slice(0, 254) : null, c.ip, c.country || null, c.city || null, c.asn, c.asOrg || null, c.ua || null)
      .run();
  } catch (err) {
    console.error('attempt log failed', err instanceof Error ? err.message : 'unknown');
  }
}

export const ADMIN_BAN_AFTER = 8; // failed admin sign-ins from one address in 15 min (not configurable: this door is special)

/**
 * Called after an attempt was logged. Bans the address when it crossed the threshold:
 *   login          ≥ auto_ban_login_fails failures in 15 min
 *   admin_login    ≥ ADMIN_BAN_AFTER failures in 15 min
 *   register       ≥ auto_ban_registers attempts in 1 h
 * Manual blocks are never overwritten by an automatic one.
 */
export async function maybeAutoBan(env: Env, request: Request, kind: AttemptKind): Promise<boolean> {
  try {
    const settings = await getSettings(env);
    const { ip } = clientOf(request);
    if (!settings.auto_ban || ip === 'unknown' || isPrivateIp(ip)) return false;   // never ban our own / internal addresses
    const now = Math.floor(Date.now() / 1000);

    let count: number;
    let limit: number;
    let why: string;
    if (kind === 'register') {
      limit = settings.auto_ban_registers;
      why = `${limit}+ sign-up attempts in 1 h`;
      const r = await env.DB
        .prepare(`SELECT COUNT(*) AS n FROM auth_attempts WHERE ip = ?1 AND kind = 'register' AND ts > ?2 AND (reason IS NULL OR reason NOT LIKE 'blocked%')`)
        .bind(ip, now - 3600)
        .first<{ n: number }>();
      count = r?.n ?? 0;
    } else {
      limit = kind === 'admin_login' ? ADMIN_BAN_AFTER : settings.auto_ban_login_fails;
      why = `${limit}+ failed ${kind === 'admin_login' ? 'admin ' : ''}sign-ins in 15 min`;
      const r = await env.DB
        .prepare(`SELECT COUNT(*) AS n FROM auth_attempts WHERE ip = ?1 AND kind = ?2 AND ok = 0 AND ts > ?3 AND (reason IS NULL OR reason NOT LIKE 'blocked%')`)
        .bind(ip, kind, now - 900)
        .first<{ n: number }>();
      count = r?.n ?? 0;
    }
    if (count < limit) return false;

    await env.DB
      .prepare(
        `INSERT INTO ip_blocks (kind, value, reason, source, expires_at, created_by)
         VALUES ('ip', ?1, ?2, 'auto', ?3, 'auto')
         ON CONFLICT(kind, value) DO UPDATE SET reason = excluded.reason, expires_at = excluded.expires_at
         WHERE ip_blocks.source = 'auto'`,
      )
      .bind(ip, why, now + settings.auto_ban_hours * 3600)
      .run();
    invalidateGuardCache();
    return true;
  } catch (err) {
    console.error('auto-ban failed', err instanceof Error ? err.message : 'unknown');
    return false;
  }
}
