/**
 * POST /api/oauth/token: the code (PKCE) or a refresh token for an access token. Form-encoded, as the OAuth spec says (JSON is accepted too).
 * A code works once; a refresh token works once and is replaced. Using either a second time means it leaked, so the whole grant is cut off.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { json } from '../lib/http';
import { bump, clientIp, retryAfter } from '../lib/throttle';
import { ACCESS_TTL, CORS, REFRESH_PREFIX, hashSecret, issueTokens, pkceOk, preflight, revokeGrant } from '../lib/oauth';

const err = (status: number, error: string, description: string): Response => json({ error, error_description: description }, status, CORS);
const MAX_BODY = 8192;

async function params(request: Request): Promise<Record<string, string> | null> {
  const raw = await request.text();
  if (raw.length > MAX_BODY) return null;
  const out: Record<string, string> = {};
  if ((request.headers.get('content-type') ?? '').includes('json')) {
    try {
      const o = JSON.parse(raw);
      if (typeof o !== 'object' || o === null) return null;
      for (const [k, v] of Object.entries(o)) if (typeof v === 'string') out[k] = v;
    } catch { return null; }
    return out;
  }
  for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
  return out;
}

const answer = (access: string, refresh: string): Response =>
  json({ access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token: refresh, scope: 'vane' }, 200, { ...CORS, 'Cache-Control': 'no-store', Pragma: 'no-cache' });

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const rl = `oauthtoken:${clientIp(request)}`;
  if (await retryAfter(env, rl, 60)) return err(429, 'temporarily_unavailable', 'Too many requests. Try again later.');
  await bump(env, rl, 600);
  const p = await params(request);
  if (!p) return err(400, 'invalid_request', 'Bad request body.');
  const now = Math.floor(Date.now() / 1000);

  if (p.grant_type === 'authorization_code') {
    const { code, code_verifier: verifier, client_id: clientId, redirect_uri: redirectUri } = p;
    if (!code || !verifier || !clientId) return err(400, 'invalid_request', 'code, code_verifier and client_id are required.');
    const hash = await hashSecret(code);
    const row = await env.DB.prepare('SELECT client_id, grant_id, redirect_uri, code_challenge, expires_at, used_at FROM oauth_codes WHERE code_hash = ?1')
      .bind(hash).first<{ client_id: string; grant_id: string; redirect_uri: string; code_challenge: string; expires_at: number; used_at: number | null }>();
    if (!row || row.client_id !== clientId) return err(400, 'invalid_grant', 'The code is not valid.');
    if (row.used_at !== null) { await revokeGrant(env, row.grant_id, now); return err(400, 'invalid_grant', 'The code was already used.'); }
    if (row.expires_at < now) return err(400, 'invalid_grant', 'The code has expired.');
    if (redirectUri !== undefined && redirectUri !== row.redirect_uri) return err(400, 'invalid_grant', 'redirect_uri does not match.');
    if (!(await pkceOk(verifier, row.code_challenge))) return err(400, 'invalid_grant', 'The code_verifier does not match.');
    const took = await env.DB.prepare('UPDATE oauth_codes SET used_at = ?2 WHERE code_hash = ?1 AND used_at IS NULL').bind(hash, now).run();
    if (took.meta.changes !== 1) return err(400, 'invalid_grant', 'The code was already used.');
    const t = await issueTokens(env, row.grant_id, now);
    return answer(t.access, t.refresh);
  }

  if (p.grant_type === 'refresh_token') {
    const { refresh_token: refresh, client_id: clientId } = p;
    if (!refresh || !refresh.startsWith(REFRESH_PREFIX) || refresh.length > 100 || !clientId) return err(400, 'invalid_request', 'refresh_token and client_id are required.');
    const hash = await hashSecret(refresh);
    const row = await env.DB
      .prepare(`SELECT t.grant_id, t.expires_at, t.used_at, g.client_id, g.revoked_at FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id WHERE t.token_hash = ?1 AND t.kind = 'refresh'`)
      .bind(hash).first<{ grant_id: string; expires_at: number; used_at: number | null; client_id: string; revoked_at: number | null }>();
    if (!row || row.client_id !== clientId || row.revoked_at !== null) return err(400, 'invalid_grant', 'The refresh token is not valid.');
    if (row.used_at !== null) { await revokeGrant(env, row.grant_id, now); return err(400, 'invalid_grant', 'The refresh token was already used.'); }
    if (row.expires_at < now) return err(400, 'invalid_grant', 'The refresh token has expired.');
    const took = await env.DB.prepare('UPDATE oauth_tokens SET used_at = ?2 WHERE token_hash = ?1 AND used_at IS NULL').bind(hash, now).run();
    if (took.meta.changes !== 1) return err(400, 'invalid_grant', 'The refresh token was already used.');
    const t = await issueTokens(env, row.grant_id, now);
    return answer(t.access, t.refresh);
  }

  return err(400, 'unsupported_grant_type', 'Use authorization_code or refresh_token.');
};

export const onRequestOptions: PagesFunction<Env> = async () => preflight();
export const onRequest: PagesFunction<Env> = async () => json({ error: 'invalid_request' }, 405, { ...CORS, Allow: 'POST, OPTIONS' });
