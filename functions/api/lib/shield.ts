/**
 * The API shield: cheap checks that run in front of EVERY /api/ request (functions/_middleware.ts), before any route code,
 * database query or secret is touched. It is defense in depth, not a replacement for Cloudflare's own edge rules
 * (documentation/API_PROTECTION.md lists those): this layer knows Vane (which paths are browser-only, which are uploads,
 * which come from other companies' servers) and can ban for good.
 *
 *   before the route (shieldBefore):
 *     1. only real HTTP methods                      TRACE / CONNECT and friends → 405
 *     2. absurdly long address                       → 414
 *     3. attack-tool User-Agents (sqlmap, nikto …)   → 403 + strikes
 *     4. a browser-only door without a User-Agent    → 403 (login, sign-up, verify, resend, waitlist: real browsers always send one)
 *     5. an address in a cool-down                   → 429
 *     6. the blocklist (manual + automatic bans, CIDR, ASN, country) → 403, for the whole API, not just sign-in
 *     7. a burst limit per address                   → 429 (100 requests / 10 s; API clients with a Vane key get 3x)
 *     8. a request body far too big for a JSON door  → 413 (uploads are exempt, they have their own caps)
 *   after the route (shieldAfter):
 *     scanners and probes produce errors (unknown path, wrong method, forbidden). Each such answer is a "strike"; an address
 *     with 15 strikes in a minute is cooled down for 5 minutes, with 30 it is banned for `auto_ban_hours` (an automatic block
 *     in ip_blocks, visible and removable in the admin panel, the same mechanism as the sign-in ban).
 *
 * What it deliberately does NOT do
 *  - It does not block hosting / VPN networks: Zapier, Make, GPT actions and customers' servers call the API from there.
 *  - Wrong API keys are not strikes here (many customers share one Zapier address); they have their own limit in apikeys.ts.
 *  - Other companies' servers (Telegram's webhook, Meta's deauthorize / data-deletion calls) skip the blocklist and are never
 *    answered with a User-Agent rule: they prove who they are with a secret or a signature instead.
 *  - Local development (no Cloudflare address header) and private addresses are never limited or banned.
 *
 * Counters live in memory of each Cloudflare isolate (no database cost per request). That makes the limits approximate (a flood is
 * spread over many data centers), which is fine for bots from one place; the ban, once issued, is in D1 and applies everywhere.
 * Kill switch: set the variable SHIELD_OFF=1 and the shield steps aside.
 */
import type { Env } from '../../../types';
import { clientOf, evaluate, invalidateGuardCache, type Client } from './guard';
import { fail } from './http';
import { isPrivateIp } from './ipaddr';
import { getSettings } from './settings';

// ───────────────────────── tunables ─────────────────────────
export const BURST_WINDOW_MS = 10_000;
export const BURST_LIMIT = 100;                 // requests per window per address
export const BURST_LIMIT_API_CLIENT = 300;      // for callers that send a Vane API key (their keys have their own per-minute limit)
export const STRIKE_WINDOW_MS = 60_000;
export const STRIKES_COOLDOWN = 15;
export const STRIKES_BAN = 30;
export const COOLDOWN_MS = 5 * 60_000;
export const MAX_BODY_BYTES = 1_048_576;        // a JSON door never needs more than this
const MAX_URL_LENGTH = 2048;
const TABLE_CAP = 5000;

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const SCANNER_UA = /\b(sqlmap|nikto|nmap|masscan|zgrab|acunetix|nessus|openvas|dirbuster|gobuster|dirb|wpscan|nuclei|ffuf|feroxbuster|wfuzz|hydra|havij|w3af|arachni|metasploit|jaeles|netsparker|appscan|burpcollaborator)\b/i;
const API_KEY_HEADER = /^Bearer\s+c(?:post|vid)_/i;

/** Doors a person opens with a browser and nothing else: a request without a User-Agent there is a script. */
const BROWSER_ONLY = new Set(['/api/auth/login', '/api/auth/register', '/api/auth/verify', '/api/auth/resend', '/api/waitlist', '/api/admin/login']);
/** Called by other companies' servers: they authenticate with a secret / signature, so no blocklist, no User-Agent rule. */
const SERVER_TO_SERVER = new Set(['/api/telegram/webhook', '/api/billing/monobank', '/api/channels/threads/deauthorize', '/api/channels/threads/delete']);
/** Big bodies (uploads) and fetches by other companies' servers (Telegram, Meta read our media): no burst limit, no size cap. */
const UPLOADS = ['/api/media/upload', '/api/video/', '/api/v1/video/'];
const PUBLIC_MEDIA = '/api/media/';

const startsWithAny = (path: string, prefixes: string[]): boolean => prefixes.some((p) => path.startsWith(p));

// ───────────────────────── memory counters ─────────────────────────
interface Burst { start: number; n: number }
interface Strikes { start: number; n: number; cooldownUntil: number }
const bursts = new Map<string, Burst>();
const strikes = new Map<string, Strikes>();

/** Only for tests */
export const resetShield = (): void => { bursts.clear(); strikes.clear(); };

function bounded<T>(m: Map<string, T>): void {
  if (m.size > TABLE_CAP) m.clear(); // under attack from thousands of addresses: forget, rather than grow without limit
}

/** true while the address is within its budget */
function withinBurst(ip: string, limit: number, now: number): boolean {
  const e = bursts.get(ip);
  if (!e || now - e.start >= BURST_WINDOW_MS) {
    bounded(bursts);
    bursts.set(ip, { start: now, n: 1 });
    return true;
  }
  return ++e.n <= limit;
}

function addStrikes(ip: string, weight: number, now: number): Strikes {
  let e = strikes.get(ip);
  if (!e || now - e.start >= STRIKE_WINDOW_MS) {
    bounded(strikes);
    e = { start: now, n: 0, cooldownUntil: e?.cooldownUntil ?? 0 };
    strikes.set(ip, e);
  }
  e.n += weight;
  return e;
}

const limited = (ip: string): boolean => ip !== 'unknown' && !isPrivateIp(ip);

// ───────────────────────── banning ─────────────────────────
/** Writes an automatic ban (never over a manual one) and drops the cached blocklist. Never throws. */
export async function banAddress(env: Env, ip: string, reason: string, nowSec: number): Promise<boolean> {
  try {
    const settings = await getSettings(env);
    if (!settings.auto_ban || !limited(ip)) return false;
    await env.DB
      .prepare(
        `INSERT INTO ip_blocks (kind, value, reason, source, expires_at, created_by)
         VALUES ('ip', ?1, ?2, 'auto', ?3, 'auto')
         ON CONFLICT(kind, value) DO UPDATE SET reason = excluded.reason, expires_at = excluded.expires_at
         WHERE ip_blocks.source = 'auto'`,
      )
      .bind(ip, reason, nowSec + settings.auto_ban_hours * 3600)
      .run();
    invalidateGuardCache();
    console.warn(`shield: banned ${ip} for ${settings.auto_ban_hours} h (${reason})`);
    return true;
  } catch (err) {
    console.error('shield: ban failed', err instanceof Error ? err.message : 'unknown');
    return false;
  }
}

// ───────────────────────── before the route ─────────────────────────
/** null = carry on to the route; otherwise the answer to send instead. `client` is passed in only to avoid parsing the request twice. */
export async function shieldBefore(env: Env, request: Request, path: string, client: Client = clientOf(request)): Promise<Response | null> {
  if ((env as { SHIELD_OFF?: string }).SHIELD_OFF === '1') return null;
  const now = Date.now();
  const ip = client.ip;
  const watch = limited(ip);

  if (!METHODS.has(request.method)) return fail(405, 'Method not allowed', { Allow: [...METHODS].join(', ') });
  if (request.url.length > MAX_URL_LENGTH) return fail(414, 'Address too long');

  const serverToServer = SERVER_TO_SERVER.has(path);
  if (!serverToServer && SCANNER_UA.test(client.ua)) {
    if (watch) await escalate(env, ip, 10, now);
    return fail(403, 'Forbidden');
  }
  if (!serverToServer && !client.ua && BROWSER_ONLY.has(path)) return fail(403, 'Forbidden');

  if (!watch) return null;

  const e = strikes.get(ip);
  if (e && e.cooldownUntil > now) {
    const wait = Math.ceil((e.cooldownUntil - now) / 1000);
    return fail(429, 'Too many requests. Slow down and try again later.', { 'Retry-After': String(wait) });
  }

  if (!serverToServer) {
    const verdict = await evaluate(env, client, 'api');
    if (verdict.blocked) return fail(403, 'Access from your network is blocked.');
  }

  if (!startsWithAny(path, UPLOADS) && !path.startsWith(PUBLIC_MEDIA)) {
    const limit = API_KEY_HEADER.test(request.headers.get('authorization') ?? '') ? BURST_LIMIT_API_CLIENT : BURST_LIMIT;
    if (!withinBurst(ip, limit, now)) {
      const wait = Math.ceil(BURST_WINDOW_MS / 1000);
      return fail(429, 'Too many requests. Slow down and try again shortly.', { 'Retry-After': String(wait) });
    }
  }

  if (request.method !== 'GET' && request.method !== 'HEAD' && !startsWithAny(path, UPLOADS)) {
    if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return fail(413, 'Request body is too large');
  }
  return null;
}

// ───────────────────────── after the route ─────────────────────────
/** Strike weight of an answer: probing leaves 404s (unknown paths), 405s (wrong methods) and 401/403s with no credentials at all. */
export function strikeWeight(status: number, path: string, request: Request): number {
  if (path.startsWith(PUBLIC_MEDIA)) return 0;              // a missing picture is not probing (and Telegram / Meta fetch these)
  if (path === '/api/auth/me' || path === '/api/auth/config') return 0; // the landing page asks "am I signed in?" for every visitor: 401 is the normal answer
  if (status === 404 || status === 405) return 1;
  if ((status === 401 || status === 403) && !request.headers.has('authorization') && !request.headers.has('cookie')) return 1;
  return 0;
}

async function escalate(env: Env, ip: string, weight: number, now: number): Promise<void> {
  const e = addStrikes(ip, weight, now);
  if (e.n >= STRIKES_BAN) {
    e.cooldownUntil = now + 60 * 60_000;                    // and the ban itself lives in D1 from here on
    await banAddress(env, ip, `scanning: ${e.n}+ unknown or forbidden API requests in 1 min`, Math.floor(now / 1000));
  } else if (e.n >= STRIKES_COOLDOWN && e.cooldownUntil <= now) {
    e.cooldownUntil = now + COOLDOWN_MS;
  }
}

/** Called with the status the route answered with. Never throws. */
export async function shieldAfter(env: Env, request: Request, path: string, status: number, client: Client = clientOf(request)): Promise<void> {
  try {
    if ((env as { SHIELD_OFF?: string }).SHIELD_OFF === '1' || !limited(client.ip)) return;
    const w = strikeWeight(status, path, request);
    if (w) await escalate(env, client.ip, w, Date.now());
  } catch (err) {
    console.error('shield: strike failed', err instanceof Error ? err.message : 'unknown');
  }
}

// ───────────────────────── answers ─────────────────────────
/** Headers every API answer should carry (Pages' _headers file only covers static files, not Functions). Only fills what is missing. */
export function withApiHeaders(res: Response): Response {
  if (res.status === 101) return res;
  const h = res.headers;
  const json = (h.get('content-type') ?? '').includes('json');
  const need = !h.has('strict-transport-security') || (json && !h.has('content-security-policy')) || !h.has('x-content-type-options') || (json && !h.has('cache-control')) || !h.has('referrer-policy');
  if (!need) return res;
  const out = new Response(res.body, res);
  if (!h.has('strict-transport-security')) out.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (json && !h.has('content-security-policy')) out.headers.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  if (!h.has('x-content-type-options')) out.headers.set('X-Content-Type-Options', 'nosniff');
  if (!h.has('referrer-policy')) out.headers.set('Referrer-Policy', 'no-referrer');
  if (json && !h.has('cache-control')) out.headers.set('Cache-Control', 'no-store');
  return out;
}
