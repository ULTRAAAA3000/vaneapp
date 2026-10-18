/**
 * API keys (ECONOMY_AND_FINANCE.md §6, SECURITY_ARCHITECTURE.md §3).
 *
 *   cpost_live_<random>   text/media endpoints, counted against the quota
 *   cpost_test_<random>   the same endpoints, answers are SIMULATED: nothing is posted, nothing is counted
 *   cvid_live_/cvid_test_ Video Engine (/api/v1/video/*): needs the Video Engine, which is sold apart from the posting plans
 *
 * Every key is random (crypto.getRandomValues) and unique to one account. Only its SHA-256 is stored, so a leaked
 * database yields hashes that cannot be turned back into keys. The key is shown to its owner exactly once.
 *
 * Protected public routes start with:
 *     const auth = await requireApiKey(request, env, 'post');
 *     if (!auth.ok) return auth.response;
 */
import type { Env, KeyMode, KeyScope } from '../../../types';
import { failCode } from './http';
import { apiAllowed, resolveSubscription, type Subscription, type SubscriptionRow } from './plans';
import { bump, retryAfter } from './throttle';
import { loadVideoSubscription, videoEngineRequired } from './videoplans';

/** Random characters in a key (62 symbols each, so ~143 bits; the spec asks for at least 16). */
export const KEY_RANDOM_LEN = 24;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

const PREFIX: Record<KeyScope, string> = { post: 'cpost', video: 'cvid' };
const KEY_RE = new RegExp(`^(cpost|cvid)_(live|test)_([A-Za-z0-9]{${KEY_RANDOM_LEN}})$`);

/** Requests a minute per key (SECURITY_ARCHITECTURE.md §2.2). */
const RATE_LIMIT_PER_MINUTE: Record<KeyScope, number> = { post: 100, video: 10 };

export const MAX_KEYS_PER_USER = 10;

/** SHA-256 hex of a key: the only form that is stored. */
export async function hashApiKey(rawKey: string): Promise<string> {
  const data = new TextEncoder().encode(rawKey);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** n random base62 characters with no modulo bias (bytes ≥ 248 are thrown away, 248 = 62 × 4). */
function randomBase62(n: number): string {
  let out = '';
  while (out.length < n) {
    for (const b of crypto.getRandomValues(new Uint8Array(n * 2))) {
      if (b < 248) {
        out += ALPHABET[b % 62];
        if (out.length === n) break;
      }
    }
  }
  return out;
}

export interface NewKey {
  /** the full key: show it once, never store it */
  secret: string;
  hash: string;
  /** last 4 characters, stored so the owner can tell keys apart in a list */
  hint: string;
}

export async function generateApiKey(scope: KeyScope, mode: KeyMode): Promise<NewKey> {
  const random = randomBase62(KEY_RANDOM_LEN);
  const secret = `${PREFIX[scope]}_${mode}_${random}`;
  return { secret, hash: await hashApiKey(secret), hint: random.slice(-4) };
}

/** "cpost_live_••••ab12": enough to recognise a key, useless to anyone else. */
export const displayKey = (scope: KeyScope, mode: KeyMode, hint: string): string => `${PREFIX[scope]}_${mode}_••••${hint}`;

/** Pure format check: runs BEFORE any database access, so junk and JWTs are dropped for free. */
export function parseApiKey(raw: string): { scope: KeyScope; mode: KeyMode } | null {
  const m = KEY_RE.exec(raw);
  if (!m) return null;
  return { scope: m[1] === 'cpost' ? 'post' : 'video', mode: m[2] as KeyMode };
}

// ───────────────────────── authentication ─────────────────────────

export interface ApiKeyContext {
  userId: string;
  key: { id: string; name: string; scope: KeyScope; mode: KeyMode };
  /** the plan that applies right now */
  sub: Subscription;
}

export type ApiKeyAuth = ({ ok: true } & ApiKeyContext) | { ok: false; response: Response };

interface KeyRow extends SubscriptionRow {
  id: string;
  user_id: string;
  name: string;
  scope: KeyScope;
  mode: KeyMode;
  last_used_at: number | null;
}

const WWW = { 'WWW-Authenticate': 'Bearer' };
const LAST_USED_GRANULARITY = 60;

/**
 * Authenticates `Authorization: Bearer <api key>` for a route that needs a key of `need` scope.
 *
 *   401 invalid_api_key    missing / malformed / unknown / revoked (all look the same: no key probing)
 *   403 wrong_key_scope    a cvid_ key on a text route or the other way round (answered before the database is touched)
 *   429 rate_limited       more than 100 requests a minute on this key (10 for video keys)
 *   403 api_not_in_plan    a LIVE text key whose plan has no API access (Pro without the API Add-on). Test keys always pass.
 *   403 video_engine_required  a LIVE video key on an account without an active Video Engine. Test keys always pass.
 */
export async function requireApiKey(request: Request, env: Env, need: KeyScope): Promise<ApiKeyAuth> {
  const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '');
  if (!bearer) {
    return { ok: false, response: failCode(401, 'invalid_api_key', 'Missing API key. Send it as "Authorization: Bearer <your key>".', {}, WWW) };
  }

  const parsed = parseApiKey(bearer[1]);
  if (!parsed) return { ok: false, response: failCode(401, 'invalid_api_key', 'Invalid API key.', {}, WWW) };

  if (parsed.scope !== need) {
    return {
      ok: false,
      response: failCode(403, 'wrong_key_scope', need === 'post'
        ? 'This is a Video Engine key. Use a cpost_ key on this endpoint.'
        : 'This is a text-post key. Use a cvid_ key on this endpoint.'),
    };
  }

  const row = await env.DB
    .prepare(
      `SELECT k.id, k.user_id, k.name, k.scope, k.mode, k.last_used_at,
              s.plan, s.api_addon, s.status, s.current_period_end, s.overage_enabled
         FROM api_keys k LEFT JOIN subscriptions s ON s.user_id = k.user_id
        WHERE k.key_hash = ?1 AND k.revoked_at IS NULL`,
    )
    .bind(await hashApiKey(bearer[1]))
    .first<KeyRow>();
  if (!row) return { ok: false, response: failCode(401, 'invalid_api_key', 'Invalid API key.', {}, WWW) };

  // Rate limit per key (fixed one-minute window).
  const rlKey = `apikey:${row.id}`;
  const limit = RATE_LIMIT_PER_MINUTE[row.scope];
  const wait = await retryAfter(env, rlKey, limit);
  if (wait) {
    return {
      ok: false,
      response: failCode(429, 'rate_limited', `Too many requests. This key allows ${limit} per minute.`, { retryAfter: wait }, { 'Retry-After': String(wait) }),
    };
  }
  await bump(env, rlKey, 60);

  const now = Math.floor(Date.now() / 1000);
  const sub = resolveSubscription(row, now);

  if (row.mode === 'live' && row.scope === 'post' && !apiAllowed(sub)) {
    return {
      ok: false,
      response: failCode(403, 'api_not_in_plan', 'Your plan does not include API access. Add the API Add-on, or use a test key.'),
    };
  }
  // The Video Engine is a separate product: a video key follows ITS subscription, whatever the posting plan is.
  if (row.mode === 'live' && row.scope === 'video' && !(await loadVideoSubscription(env, row.user_id, now)).active) {
    return { ok: false, response: videoEngineRequired() };
  }

  // Cheap "last used" stamp: at most one write a minute per key.
  if (row.last_used_at === null || row.last_used_at < now - LAST_USED_GRANULARITY) {
    await env.DB.prepare('UPDATE api_keys SET last_used_at = ?2 WHERE id = ?1').bind(row.id, now).run().catch(() => undefined);
  }

  return { ok: true, userId: row.user_id, key: { id: row.id, name: row.name, scope: row.scope, mode: row.mode }, sub };
}
