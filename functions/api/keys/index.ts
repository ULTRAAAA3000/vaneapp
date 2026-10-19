/**
 * API key management for the signed-in user (dashboard / dev JWT). API keys themselves are NOT accepted here:
 * a key must never be able to mint or list keys.
 *
 *   GET  /api/keys   → my active keys (masked; the secret and the hash are never returned)
 *                      ?scope=post|video limits the list to one product: each dashboard asks for its own keys
 *   POST /api/keys   → { name, mode?: "live" | "test", scope?: "post" | "video" }  → the new key, with its SECRET (shown once)
 *   DELETE /api/keys/:id → revoke (see ./[id].ts)
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { ApiKeyPublic, Env, KeyMode, KeyScope } from '../../../types';
import { requireUser } from '../lib/auth';
import { displayKey, generateApiKey, MAX_KEYS_PER_USER } from '../lib/apikeys';
import { fail, failCode, isRecord, json, methodNotAllowed, readJson } from '../lib/http';
import { apiAllowed } from '../lib/plans';
import { loadVideoSubscription, videoEngineRequired } from '../lib/videoplans';
import { bump, retryAfter } from '../lib/throttle';
import { loadSubscription } from '../lib/usage';

const MAX_NAME_LEN = 60;

interface KeyListRow { id: string; name: string; scope: KeyScope; mode: KeyMode; hint: string; created_at: number; last_used_at: number | null }

const toPublic = (r: KeyListRow): ApiKeyPublic => ({
  id: r.id, name: r.name, scope: r.scope, mode: r.mode,
  display: displayKey(r.scope, r.mode, r.hint), createdAt: r.created_at, lastUsedAt: r.last_used_at,
});

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;

  const scope = new URL(request.url).searchParams.get('scope');
  if (scope !== null && scope !== 'post' && scope !== 'video') return fail(400, 'scope must be "post" or "video"');

  // Explicit columns: key_hash is deliberately never selected.
  const { results } = await env.DB
    .prepare('SELECT id, name, scope, mode, hint, created_at, last_used_at FROM api_keys WHERE user_id = ?1 AND revoked_at IS NULL AND (?2 IS NULL OR scope = ?2) ORDER BY created_at DESC')
    .bind(auth.userId, scope)
    .all<KeyListRow>();
  return json({ ok: true, keys: results.map(toPublic), max: MAX_KEYS_PER_USER });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;

  const parsed = await readJson(request, 4096);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  if (!isRecord(body)) return fail(400, 'Body must be a JSON object');

  const name = typeof body.name === 'string' ? body.name.replace(/[\u0000-\u001f\u007f]/g, '').trim() : '';
  if (!name || name.length > MAX_NAME_LEN) return fail(400, `name is required (max ${MAX_NAME_LEN} characters), e.g. "Make.com"`);

  const mode = body.mode === undefined ? 'live' : body.mode;
  if (mode !== 'live' && mode !== 'test') return fail(400, 'mode must be "live" or "test"');

  const scope = body.scope === undefined ? 'post' : body.scope;
  if (scope !== 'post' && scope !== 'video') return fail(400, 'scope must be "post" or "video"');

  // A live key is only useful on an account that can use it; say so now instead of failing on its first request.
  if (mode === 'live' && scope === 'post' && !apiAllowed(await loadSubscription(env, auth.userId))) {
    return failCode(403, 'api_not_in_plan', 'Your plan does not include API access. Add the API Add-on, or create a test key.');
  }
  if (mode === 'live' && scope === 'video' && !(await loadVideoSubscription(env, auth.userId)).active) {
    return videoEngineRequired();
  }

  // Creating keys is cheap for us but a good way to fill the table: 20 an hour is plenty.
  const rl = `keycreate:${auth.userId}`;
  const wait = await retryAfter(env, rl, 20);
  if (wait) return fail(429, 'Too many keys created. Try again later.', { 'Retry-After': String(wait) });

  const active = await env.DB
    .prepare('SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ?1 AND revoked_at IS NULL')
    .bind(auth.userId)
    .first<{ n: number }>();
  if ((active?.n ?? 0) >= MAX_KEYS_PER_USER) {
    return failCode(409, 'too_many_keys', `You can have up to ${MAX_KEYS_PER_USER} active keys. Revoke one you no longer use.`);
  }

  await bump(env, rl, 3600);
  const key = await generateApiKey(scope, mode);
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  try {
    await env.DB
      .prepare('INSERT INTO api_keys (id, user_id, name, scope, mode, key_hash, hint, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)')
      .bind(id, auth.userId, name, scope, mode, key.hash, key.hint, now)
      .run();
  } catch (err) {
    console.error('api key insert failed', err instanceof Error ? err.message : 'unknown');
    return fail(500, 'Could not create the key. Please try again.');
  }

  return json(
    { ok: true, key: toPublic({ id, name, scope, mode, hint: key.hint, created_at: now, last_used_at: null }), secret: key.secret },
    201,
  );
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET, POST');
