/**
 * Network guard: who may sign in, sign up or be tracked.
 *
 *   manual / auto blocks (ip, cidr, asn, country) → enforced on the whole API (shield.ts)
 *   preset blocks (hosting + VPN networks)         → sign-in / sign-up only, switch: settings.block_hosting
 *   Tor exit nodes (Cloudflare country "T1")       → sign-in / sign-up only, switch: settings.block_tor
 *   VPN / proxy lookup API (PROXYCHECK_KEY)        → sign-in / sign-up only, switch: settings.block_vpn_api
 *
 * The blocklist is read from D1 at most once per 15 s per isolate, so guarding a request is a
 * memory lookup, not a database round trip.
 */
import type { Env } from '../../../types';
import { fail } from './http';
import { inCidr, parseCidr, parseIp, sameIp, type ParsedCidr, type ParsedIp } from './ipaddr';
import { lookupProxy } from './ipintel';
import { logAttempt, type AttemptKind } from './attempts';
import { getSettings } from './settings';
import { sha256Hex } from './session';

export interface Client {
  ip: string;
  country: string;
  city: string;
  asn: number | null;
  asOrg: string;
  ua: string;
}

interface CfProps {
  country?: string;
  city?: string;
  asn?: number;
  asOrganization?: string;
}

export function clientOf(request: Request): Client {
  const cf = ((request as unknown as { cf?: CfProps }).cf ?? {}) as CfProps;
  return {
    ip: request.headers.get('cf-connecting-ip') ?? 'unknown',
    country: (cf.country ?? '').toUpperCase(),
    city: cf.city ?? '',
    asn: typeof cf.asn === 'number' ? cf.asn : null,
    asOrg: cf.asOrganization ?? '',
    ua: (request.headers.get('user-agent') ?? '').slice(0, 200),
  };
}

/** Salted hash: lets us count unique visitors without keeping their addresses. */
export async function ipHash(env: Env, ip: string): Promise<string> {
  return (await sha256Hex(`${env.JWT_SECRET ?? 'vane'}|${ip}`)).slice(0, 16);
}

// ───────────────────────── blocklist cache ─────────────────────────
export interface BlockRow {
  id: number;
  kind: 'ip' | 'cidr' | 'asn' | 'country';
  value: string;
  reason: string | null;
  source: 'manual' | 'auto' | 'preset';
  expires_at: number | null;
}
interface Compiled {
  row: BlockRow;
  ip?: ParsedIp;
  cidr?: ParsedCidr;
}

const TTL_MS = 15_000;
let cache: { at: number; rules: Compiled[] } | null = null;
export const invalidateGuardCache = (): void => {
  cache = null;
};

async function loadRules(env: Env): Promise<Compiled[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.rules;
  let rules: Compiled[] = [];
  try {
    const { results } = await env.DB
      .prepare('SELECT id, kind, value, reason, source, expires_at FROM ip_blocks')
      .all<BlockRow>();
    rules = results.map((row) => ({
      row,
      ip: row.kind === 'ip' ? (parseIp(row.value) ?? undefined) : undefined,
      cidr: row.kind === 'cidr' ? (parseCidr(row.value) ?? undefined) : undefined,
    }));
  } catch {
    /* table missing (schema not applied yet): nothing is blocked */
  }
  cache = { at: Date.now(), rules };
  return rules;
}

// ───────────────────────── evaluation ─────────────────────────
export type Scope = 'login' | 'register' | 'admin' | 'track' | 'api'; // 'api': every other /api/ request (shield.ts): manual and automatic blocks only
export type Why = 'manual' | 'auto' | 'hosting' | 'tor' | 'proxy' | 'country';
export interface Verdict {
  blocked: boolean;
  why?: Why;
  detail?: string;
}

export async function evaluate(env: Env, client: Client, scope: Scope): Promise<Verdict> {
  const settings = await getSettings(env);
  const authScope = scope === 'login' || scope === 'register';
  const now = Math.floor(Date.now() / 1000);
  const ip = parseIp(client.ip);

  for (const { row, ip: rip, cidr } of await loadRules(env)) {
    if (row.expires_at !== null && row.expires_at <= now) continue;
    if (row.source === 'preset' && !(authScope && settings.block_hosting)) continue;

    let hit = false;
    if (row.kind === 'ip') hit = !!ip && !!rip && sameIp(ip, rip);
    else if (row.kind === 'cidr') hit = !!ip && !!cidr && inCidr(ip, cidr);
    else if (row.kind === 'asn') hit = client.asn !== null && String(client.asn) === row.value;
    else if (row.kind === 'country') hit = client.country !== '' && client.country === row.value.toUpperCase();
    if (hit) {
      const why: Why = row.source === 'preset' ? 'hosting' : row.kind === 'country' ? 'country' : row.source;
      return { blocked: true, why, detail: row.reason ?? `${row.kind} ${row.value}` };
    }
  }

  if (authScope && settings.block_tor && client.country === 'T1') return { blocked: true, why: 'tor', detail: 'Tor exit node' };

  if (authScope && settings.block_vpn_api && env.PROXYCHECK_KEY) {
    const intel = await lookupProxy(env, client.ip);
    if (intel.proxy) return { blocked: true, why: 'proxy', detail: intel.kind ? `${intel.kind} (lookup)` : 'proxy / VPN (lookup)' };
  }
  return { blocked: false };
}

const NETWORK_MESSAGE = "VPN, proxy and hosting networks can't be used to sign in or sign up. Turn it off and try again.";
const BLOCKED_MESSAGE = 'Access from your network is blocked.';

// A blocked address may hammer us; log it once per 10 minutes instead of once per request.
const seen = new Map<string, number>();
function firstSightRecently(ip: string): boolean {
  const now = Date.now();
  const last = seen.get(ip);
  if (last && now - last < 600_000) return false;
  if (seen.size > 5000) seen.clear();
  seen.set(ip, now);
  return true;
}

/**
 * null = let the request through; otherwise the 403 to return.
 * Pass `logKind` to record the refusal in the attempts feed.
 */
export async function guard(env: Env, request: Request, scope: Scope, logKind?: AttemptKind): Promise<Response | null> {
  const client = clientOf(request);
  const v = await evaluate(env, client, scope);
  if (!v.blocked) return null;
  if (logKind && firstSightRecently(client.ip)) {
    await logAttempt(env, request, { kind: logKind, ok: false, reason: `blocked:${v.why}`, email: null });
  }
  const network = v.why === 'hosting' || v.why === 'tor' || v.why === 'proxy';
  return fail(403, network ? NETWORK_MESSAGE : BLOCKED_MESSAGE);
}
