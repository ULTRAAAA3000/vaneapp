/**
 * Idempotency-Key for the public API (the Stripe model, trimmed to what a scheduler needs).
 *
 * Why: Make and Zapier retry a request that timed out. Without this, the retry creates a second post and takes a
 * second unit of quota. With it, the first answer is stored and replayed.
 *
 *   Idempotency-Key: <1-255 printable characters, e.g. a UUID, or your scenario's execution id>
 *
 *   first request            runs normally; its 201 answer is stored for 24 hours
 *   same key + same body     the stored answer again (same status and body, header `Idempotent-Replayed: true`),
 *                            nothing is created and no quota is taken
 *   same key + other body    422 idempotency_key_reuse   (a key means ONE request)
 *   same key while the first is still running   409 idempotency_in_progress  (Retry-After: 1)
 *
 * Only a SUCCESSFUL (201) answer is remembered. A request that failed (bad input, out of quota, 5xx) releases the key,
 * so the retry, perhaps after fixing the input or upgrading the plan, simply runs.
 *
 * Race-free: the claim is one upsert, and the stored answer is written in the SAME D1 batch as the post and the quota
 * log, so there is no moment where the post exists but the key does not know about it.
 */
import type { D1PreparedStatement } from '@cloudflare/workers-types';
import type { Env, KeyMode } from '../../../types';
import { failCode } from './http';

export const IDEMPOTENCY_HEADER = 'Idempotency-Key';
const KEY_RE = /^[\x21-\x7E]{1,255}$/;
const TTL_SECONDS = 24 * 3600;
/** A claim older than this was abandoned (the Worker died mid-request): another request may take it over. */
const STALE_CLAIM_SECONDS = 60;
const MAX_STORED_BODY = 64 * 1024;

const sha256Hex = async (text: string): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

/** JSON with sorted keys, so `{"a":1,"b":2}` and `{"b":2,"a":1}` count as the same request. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export interface IdemClaim {
  userId: string;
  idemKey: string;
  /** the claim's token: only the request that took it can complete or release it */
  lockedAt: number;
  requestHash: string;
}

export type IdemOutcome =
  | { kind: 'none' }                                            // no header: run normally
  | { kind: 'refuse'; response: Response }                      // malformed key, reuse with another body, or still in progress
  | { kind: 'replay'; status: number; body: string }            // answer again from the first request
  | { kind: 'claimed'; claim: IdemClaim };                      // run, then store the answer (or release)

/** Looks at the header and either lets the request run (claimed), refuses it, or hands back the stored answer. */
export async function idemBegin(env: Env, request: Request, userId: string, mode: KeyMode, body: unknown, now: number): Promise<IdemOutcome> {
  const raw = request.headers.get(IDEMPOTENCY_HEADER);
  if (raw === null) return { kind: 'none' };
  if (!KEY_RE.test(raw)) {
    return {
      kind: 'refuse',
      response: failCode(400, 'invalid_idempotency_key', 'Idempotency-Key must be 1 to 255 printable characters without spaces, for example a UUID.'),
    };
  }

  const idemKey = `${mode}:${raw}`;
  const requestHash = await sha256Hex(stableStringify(body));

  // Up to two rounds: if the row we lose to is deleted before we can read it (its request failed), we simply claim it.
  for (let round = 0; round < 2; round++) {
    // Claim: a fresh insert, or take over a row that expired or whose first request was abandoned.
    const res = await env.DB
      .prepare(
        `INSERT INTO idempotency_keys (user_id, idem_key, request_hash, state, locked_at, expires_at)
         VALUES (?1, ?2, ?3, 'processing', ?4, ?5)
         ON CONFLICT(user_id, idem_key) DO UPDATE SET
           request_hash = excluded.request_hash, state = 'processing', locked_at = excluded.locked_at,
           expires_at = excluded.expires_at, response_status = NULL, response_body = NULL
         WHERE idempotency_keys.expires_at <= ?4 OR (idempotency_keys.state = 'processing' AND idempotency_keys.locked_at <= ?4 - ?6)`,
      )
      .bind(userId, idemKey, requestHash, now, now + TTL_SECONDS, STALE_CLAIM_SECONDS)
      .run();
    if ((res.meta?.changes ?? 0) > 0) return { kind: 'claimed', claim: { userId, idemKey, lockedAt: now, requestHash } };

    const row = await env.DB
      .prepare('SELECT request_hash, state, response_status, response_body FROM idempotency_keys WHERE user_id = ?1 AND idem_key = ?2')
      .bind(userId, idemKey)
      .first<{ request_hash: string; state: 'processing' | 'done'; response_status: number | null; response_body: string | null }>();
    if (!row) continue;

    if (row.request_hash !== requestHash) {
      return {
        kind: 'refuse',
        response: failCode(422, 'idempotency_key_reuse', 'This Idempotency-Key was already used with a different request. Use a new key for a new request.'),
      };
    }
    if (row.state === 'done' && row.response_status !== null && row.response_body !== null) {
      return { kind: 'replay', status: row.response_status, body: row.response_body };
    }
    return {
      kind: 'refuse',
      response: failCode(409, 'idempotency_in_progress', 'A request with this Idempotency-Key is still being processed. Retry in a moment.', {}, { 'Retry-After': '1' }),
    };
  }
  return {
    kind: 'refuse',
    response: failCode(409, 'idempotency_in_progress', 'A request with this Idempotency-Key is still being processed. Retry in a moment.', {}, { 'Retry-After': '1' }),
  };
}

/** A statement that stores the answer. Put it in the same batch as the rows it describes. */
export function idemCompleteStatement(env: Env, claim: IdemClaim, status: number, body: string): D1PreparedStatement {
  // Never store an unbounded answer. Ours are a few hundred bytes; this only guards against a future bug.
  const stored = body.length > MAX_STORED_BODY ? body.slice(0, MAX_STORED_BODY) : body;
  return env.DB
    .prepare(
      `UPDATE idempotency_keys SET state = 'done', response_status = ?4, response_body = ?5
        WHERE user_id = ?1 AND idem_key = ?2 AND locked_at = ?3 AND state = 'processing'`,
    )
    .bind(claim.userId, claim.idemKey, claim.lockedAt, status, stored);
}

/** The request did not succeed: forget the key so a retry can run. */
export async function idemRelease(env: Env, claim: IdemClaim): Promise<void> {
  try {
    await env.DB
      .prepare(`DELETE FROM idempotency_keys WHERE user_id = ?1 AND idem_key = ?2 AND locked_at = ?3 AND state = 'processing'`)
      .bind(claim.userId, claim.idemKey, claim.lockedAt)
      .run();
  } catch (err) {
    // Not fatal: the claim goes stale after a minute and the retry can take it over.
    console.error('idempotency release failed', err instanceof Error ? err.message : 'unknown');
  }
}

/** Housekeeping for the cron worker: forget keys older than their 24 hours. */
export async function purgeExpiredIdempotencyKeys(env: Pick<Env, 'DB'>, now: number): Promise<void> {
  await env.DB.prepare('DELETE FROM idempotency_keys WHERE expires_at <= ?1').bind(now).run();
}
