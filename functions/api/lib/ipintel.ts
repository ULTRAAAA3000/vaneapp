/**
 * Optional VPN / proxy lookup through proxycheck.io (set PROXYCHECK_KEY).
 * Answers are cached in D1 for a day. If the service is slow or down we let the visitor through:
 * a lookup outage must never lock real users out.
 */
import type { Env } from '../../../types';
import { parseIp } from './ipaddr';

const CACHE_SECONDS = 24 * 3600;
const TIMEOUT_MS = 2500;

export interface Intel {
  proxy: boolean;
  kind?: string;
}

export async function lookupProxy(env: Env, ip: string): Promise<Intel> {
  if (!env.PROXYCHECK_KEY || !parseIp(ip)) return { proxy: false };
  const now = Math.floor(Date.now() / 1000);
  try {
    const hit = await env.DB
      .prepare('SELECT is_proxy, kind FROM ip_intel WHERE ip = ?1 AND checked_at > ?2')
      .bind(ip, now - CACHE_SECONDS)
      .first<{ is_proxy: number; kind: string | null }>();
    if (hit) return { proxy: hit.is_proxy === 1, kind: hit.kind ?? undefined };

    const url = `https://proxycheck.io/v2/${encodeURIComponent(ip)}?key=${encodeURIComponent(env.PROXYCHECK_KEY)}&vpn=1&asn=1`;
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return { proxy: false };
    const data = (await res.json()) as Record<string, unknown>;
    if (data.status !== 'ok') return { proxy: false };
    const entry = data[ip] as { proxy?: string; type?: string } | undefined;
    if (!entry) return { proxy: false };
    const proxy = entry.proxy === 'yes';
    await env.DB
      .prepare(
        `INSERT INTO ip_intel (ip, is_proxy, kind, checked_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(ip) DO UPDATE SET is_proxy = excluded.is_proxy, kind = excluded.kind, checked_at = excluded.checked_at`,
      )
      .bind(ip, proxy ? 1 : 0, entry.type ?? null, now)
      .run();
    return { proxy, kind: entry.type };
  } catch (err) {
    console.warn('proxy lookup failed', err instanceof Error ? err.message : 'unknown');
    return { proxy: false };
  }
}
