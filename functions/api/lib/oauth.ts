/**
 * OAuth 2.1 for the Claude connector (the remote MCP server at /api/v1/mcp). This file is NOT a route.
 *
 * Claude discovers everything from /.well-known/*, registers itself (RFC 7591), sends the person to /connect, and exchanges the
 * code (PKCE S256) at /api/oauth/token. The access token is opaque: it points at a grant, and the grant holds one ordinary API key
 * (encrypted) that the MCP endpoint then uses for the inner calls, so plan, quota, test mode and revocation work exactly as for the API.
 */
import type { Env } from '../../../types';
import { toB64Url } from './encoding';
import { ROOT_DOMAIN, siteOf } from './hosts';
import { sha256Hex } from './session';

export const ACCESS_TTL = 3600;
export const REFRESH_TTL = 90 * 86400;
export const CODE_TTL = 600;
export const MAX_REDIRECTS = 5;
export const CONNECTOR_KEY_NAME = 'Claude connector';

export const ACCESS_PREFIX = 'vane_at_';
export const REFRESH_PREFIX = 'vane_rt_';
const CODE_PREFIX = 'vane_ac_';

export const newSecret = (prefix: string): string => prefix + toB64Url(crypto.getRandomValues(new Uint8Array(32)));
export const newCode = (): string => newSecret(CODE_PREFIX);
export const newAccess = (): string => newSecret(ACCESS_PREFIX);
export const newRefresh = (): string => newSecret(REFRESH_PREFIX);
export const hashSecret = (s: string): Promise<string> => sha256Hex(s);

/** The public address of the site: the main domain in production, the request's own origin in local dev and previews. */
export const issuerOf = (request: Request): string => {
  const u = new URL(request.url);
  return siteOf(u.hostname) === 'other' ? u.origin : `https://${ROOT_DOMAIN}`;
};
export const mcpUrl = (request: Request): string => `${issuerOf(request)}/api/v1/mcp`;
export const resourceMetadataUrl = (request: Request): string => `${issuerOf(request)}/.well-known/oauth-protected-resource`;

export const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, MCP-Protocol-Version',
  'Access-Control-Max-Age': '86400',
};
export const preflight = (): Response => new Response(null, { status: 204, headers: CORS });

/** https only, or http on the person's own machine (Claude Desktop and Claude Code listen on a local port). No fragments, no credentials in the address. */
export function validRedirectUri(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length > 512) return false;
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.hash || u.username || u.password) return false;
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]');
}

export const cleanName = (v: unknown, fallback: string): string => {
  const t = typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) : '';
  return t || fallback;
};

export interface OauthClient { clientId: string; name: string; redirectUris: string[] }

export async function loadClient(env: Pick<Env, 'DB'>, clientId: string): Promise<OauthClient | null> {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(clientId)) return null;
  const row = await env.DB.prepare('SELECT client_id, client_name, redirect_uris FROM oauth_clients WHERE client_id = ?1').bind(clientId).first<{ client_id: string; client_name: string; redirect_uris: string }>();
  if (!row) return null;
  try {
    const uris = JSON.parse(row.redirect_uris);
    return Array.isArray(uris) ? { clientId: row.client_id, name: row.client_name, redirectUris: uris.filter((x): x is string => typeof x === 'string') } : null;
  } catch {
    return null;
  }
}

/** PKCE, S256 only: base64url(sha256(verifier)) must equal the challenge the client sent first. */
export async function pkceOk(verifier: string, challenge: string): Promise<boolean> {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return toB64Url(digest) === challenge;
}
export const validChallenge = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v);

/** A new access + refresh pair for a grant. */
export async function issueTokens(env: Pick<Env, 'DB'>, grantId: string, now: number): Promise<{ access: string; refresh: string }> {
  const access = newAccess();
  const refresh = newRefresh();
  const ins = env.DB.prepare('INSERT INTO oauth_tokens (token_hash, kind, grant_id, expires_at) VALUES (?1, ?2, ?3, ?4)');
  await env.DB.batch([
    ins.bind(await hashSecret(access), 'access', grantId, now + ACCESS_TTL),
    ins.bind(await hashSecret(refresh), 'refresh', grantId, now + REFRESH_TTL),
  ]);
  return { access, refresh };
}

export const revokeGrant = async (env: Pick<Env, 'DB'>, grantId: string, now: number): Promise<void> => {
  await env.DB.batch([
    env.DB.prepare('UPDATE oauth_grants SET revoked_at = ?2 WHERE id = ?1 AND revoked_at IS NULL').bind(grantId, now),
    env.DB.prepare('DELETE FROM oauth_tokens WHERE grant_id = ?1').bind(grantId),
  ]);
};

/** Old codes and tokens, grants that were revoked, and clients nobody ever finished connecting. */
export async function purgeOauth(env: Pick<Env, 'DB'>, now = Math.floor(Date.now() / 1000)): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM oauth_codes WHERE expires_at < ?1').bind(now - 3600),
    env.DB.prepare('DELETE FROM oauth_tokens WHERE expires_at < ?1').bind(now),
    env.DB.prepare('DELETE FROM oauth_grants WHERE revoked_at IS NOT NULL AND revoked_at < ?1').bind(now - 7 * 86400),
    env.DB.prepare('DELETE FROM oauth_clients WHERE created_at < ?1 AND client_id NOT IN (SELECT client_id FROM oauth_grants)').bind(now - 2 * 86400),
  ]).catch(() => undefined);
}

export interface Authorized { grantId: string; keyId: string; keyEnc: string; userId: string }

/** The grant behind an access token, or null (unknown, expired, or the grant/key was revoked). */
export async function grantForAccessToken(env: Pick<Env, 'DB'>, token: string, now: number): Promise<Authorized | null> {
  if (!token.startsWith(ACCESS_PREFIX) || token.length > 100) return null;
  const row = await env.DB
    .prepare(`SELECT g.id AS grant_id, g.key_id, g.key_enc, g.user_id
                FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id JOIN api_keys k ON k.id = g.key_id
               WHERE t.token_hash = ?1 AND t.kind = 'access' AND t.expires_at > ?2 AND g.revoked_at IS NULL AND k.revoked_at IS NULL`)
    .bind(await hashSecret(token), now)
    .first<{ grant_id: string; key_id: string; key_enc: string; user_id: string }>();
  return row ? { grantId: row.grant_id, keyId: row.key_id, keyEnc: row.key_enc, userId: row.user_id } : null;
}
