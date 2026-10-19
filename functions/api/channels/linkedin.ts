/**
 * LinkedIn integration: a person's own profile (products "Share on LinkedIn" + "Sign In with LinkedIn using OpenID Connect").
 *
 *   linkedinConfigured(env)               are LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET set? (the connect button is off until they are)
 *   authorizeUrl(env, redirectUri, state)  where to send the person to press "Allow"
 *   exchangeCode(env, redirectUri, code)   code → access token (+ refresh token where LinkedIn gives one)
 *   readProfile(accessToken)               "who is this?" (OpenID userinfo) → the member id that becomes the author URN
 *   sendLinkedinPost(...)                  POST /rest/posts (+ /rest/images for one picture)
 *   linkedinCommentary(text)               the text in LinkedIn's "little text format": reserved characters escaped, #tags kept clickable
 *
 * Security notes
 *  - Scopes are the smallest that work: openid + profile (which member is this) and w_member_social (create posts as that member).
 *    Vane cannot read the feed, messages or connections. Company pages (w_organization_social) need LinkedIn's separate
 *    Community Management API approval and are NOT requested here: asking for a scope the app does not have makes LinkedIn refuse the sign-in.
 *  - The access token (and a refresh token, if any) is stored encrypted (AES-GCM, see ../lib/crypto.ts), never logged or returned.
 *  - The picture's upload address comes from LinkedIn, and the token is sent to it, so it is only used when it is an https
 *    address on linkedin.com / licdn.com.
 *  - A LinkedIn sign-in lasts 60 days. Without a refresh token (the normal case) the person has to connect again; the dashboard
 *    shows "Reconnect" before that, and a post that finds the sign-in expired fails with a clear message instead of retrying.
 *
 * This file is NOT a route: it only exports helpers (Pages ignores files without onRequest*).
 */
import { decryptToken } from '../lib/crypto';
import { callJson, shortMessage, type CallErr } from '../lib/httpcall';
import { downloadImage } from '../lib/remoteimage';

export const LINKEDIN_SCOPES = 'openid profile w_member_social';
export const LINKEDIN_TEXT_LIMIT = 3000;
export const LINKEDIN_IMAGE_MAX_BYTES = 8_000_000;
/** The Linkedin-Version header (YYYYMM). LinkedIn keeps a version for about a year; override with the LINKEDIN_VERSION variable. */
export const LINKEDIN_DEFAULT_VERSION = '202608';
/** Renew a sign-in that has less than this left (when LinkedIn gave us a refresh token) */
export const LINKEDIN_RENEW_BEFORE_SECONDS = 7 * 24 * 3600;

const AUTHORIZE = 'https://www.linkedin.com/oauth/v2/authorization';
const TOKEN = 'https://www.linkedin.com/oauth/v2/accessToken';
const API = 'https://api.linkedin.com';
const VERSION_RE = /^20\d{2}(0[1-9]|1[0-2])$/;
const URN_RE = /^urn:li:(?:person|organization):[A-Za-z0-9_-]{1,64}$/;
const UPLOAD_HOST_RE = /(^|\.)(linkedin\.com|licdn\.com)$/;

export interface LinkedinEnv {
  LINKEDIN_CLIENT_ID?: string;
  LINKEDIN_CLIENT_SECRET?: string;
  LINKEDIN_VERSION?: string;
}

export const linkedinConfigured = (env: LinkedinEnv): boolean => Boolean(env.LINKEDIN_CLIENT_ID && env.LINKEDIN_CLIENT_SECRET);

export function linkedinVersion(env: LinkedinEnv): string {
  const v = env.LINKEDIN_VERSION?.trim();
  return v && VERSION_RE.test(v) ? v : LINKEDIN_DEFAULT_VERSION;
}

// ───────────────────────── sign-in ─────────────────────────
export function authorizeUrl(env: LinkedinEnv, redirectUri: string, state: string): string {
  const q = new URLSearchParams({ response_type: 'code', client_id: env.LINKEDIN_CLIENT_ID ?? '', redirect_uri: redirectUri, state, scope: LINKEDIN_SCOPES });
  return `${AUTHORIZE}?${q.toString()}`;
}

export interface LinkedinTokens { accessToken: string; expiresAt: number; refreshToken?: string; refreshExpiresAt?: number }
export type TokenResult = { ok: true; tokens: LinkedinTokens } | { ok: false; reason: 'failed' | 'noperm' };

function tokensFrom(data: unknown, now: number): LinkedinTokens | null {
  const d = data as { access_token?: unknown; expires_in?: unknown; refresh_token?: unknown; refresh_token_expires_in?: unknown } | null;
  if (typeof d?.access_token !== 'string' || !d.access_token) return null;
  const life = typeof d.expires_in === 'number' && d.expires_in > 0 ? d.expires_in : 60 * 24 * 3600; // LinkedIn's usual 60 days
  const out: LinkedinTokens = { accessToken: d.access_token, expiresAt: now + life };
  if (typeof d.refresh_token === 'string' && d.refresh_token) {
    out.refreshToken = d.refresh_token;
    if (typeof d.refresh_token_expires_in === 'number' && d.refresh_token_expires_in > 0) out.refreshExpiresAt = now + d.refresh_token_expires_in;
  }
  return out;
}

export async function exchangeCode(env: LinkedinEnv, redirectUri: string, code: string, now = Math.floor(Date.now() / 1000)): Promise<TokenResult> {
  const r = await callJson(TOKEN, {
    method: 'POST',
    form: { grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: env.LINKEDIN_CLIENT_ID ?? '', client_secret: env.LINKEDIN_CLIENT_SECRET ?? '' },
  });
  if (!r.ok) return { ok: false, reason: 'failed' };
  const tokens = tokensFrom(r.data, now);
  if (!tokens) return { ok: false, reason: 'failed' };
  const scope = (r.data as { scope?: unknown }).scope;
  // The person may untick a permission on LinkedIn's page: without w_member_social nothing can be posted.
  if (typeof scope === 'string' && !scope.split(/[\s,]+/).includes('w_member_social')) return { ok: false, reason: 'noperm' };
  return { ok: true, tokens };
}

export type ProfileResult = { ok: true; id: string; name: string } | { ok: false };

export async function readProfile(accessToken: string): Promise<ProfileResult> {
  const r = await callJson<{ sub?: unknown; name?: unknown; given_name?: unknown; family_name?: unknown }>(`${API}/v2/userinfo`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) return { ok: false };
  const id = r.data?.sub;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{4,64}$/.test(id)) return { ok: false };
  const full = typeof r.data.name === 'string' ? r.data.name : [r.data.given_name, r.data.family_name].filter((x) => typeof x === 'string').join(' ');
  return { ok: true, id, name: full.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80) };
}

// ───────────────────────── credentials ─────────────────────────
export interface LinkedinCreds {
  urn: string;
  name: string;
  accessToken: string;
  expiresAt: number;
  refreshToken?: string;
  refreshExpiresAt?: number;
}

export function linkedinBlob(urn: string, name: string, t: LinkedinTokens): Record<string, unknown> {
  return { type: 'linkedin', urn, name, accessToken: t.accessToken, expiresAt: t.expiresAt, ...(t.refreshToken ? { refreshToken: t.refreshToken } : {}), ...(t.refreshExpiresAt ? { refreshExpiresAt: t.refreshExpiresAt } : {}) };
}

export async function loadLinkedinCreds(encrypted: string, encryptionKey: string | undefined): Promise<LinkedinCreds | null> {
  if (!encryptionKey) return null;
  try {
    const p = JSON.parse(await decryptToken(encrypted, encryptionKey));
    if (typeof p?.accessToken !== 'string' || !p.accessToken || typeof p?.urn !== 'string' || !URN_RE.test(p.urn)) return null;
    return {
      urn: p.urn,
      name: typeof p.name === 'string' ? p.name : '',
      accessToken: p.accessToken,
      expiresAt: typeof p.expiresAt === 'number' ? p.expiresAt : 0,
      refreshToken: typeof p.refreshToken === 'string' ? p.refreshToken : undefined,
      refreshExpiresAt: typeof p.refreshExpiresAt === 'number' ? p.refreshExpiresAt : undefined,
    };
  } catch {
    return null;
  }
}

/** Gets a new access token with the refresh token (only apps LinkedIn has approved for it receive one). null when it cannot be done. */
export async function renewLinkedin(env: LinkedinEnv, creds: LinkedinCreds, now: number): Promise<LinkedinCreds | null> {
  if (!creds.refreshToken || (creds.refreshExpiresAt && creds.refreshExpiresAt <= now) || !linkedinConfigured(env)) return null;
  const r = await callJson(TOKEN, {
    method: 'POST',
    form: { grant_type: 'refresh_token', refresh_token: creds.refreshToken, client_id: env.LINKEDIN_CLIENT_ID ?? '', client_secret: env.LINKEDIN_CLIENT_SECRET ?? '' },
  });
  if (!r.ok) return null;
  const t = tokensFrom(r.data, now);
  if (!t) return null;
  return { ...creds, accessToken: t.accessToken, expiresAt: t.expiresAt, refreshToken: t.refreshToken ?? creds.refreshToken, refreshExpiresAt: t.refreshExpiresAt ?? creds.refreshExpiresAt };
}

// ───────────────────────── the text ─────────────────────────
// LinkedIn reads a post's text as "little text format": these characters are markup and cut a post off unless escaped.
const RESERVED = /[\\|{}@[\]()<>#*_~]/g;
const escapeLittle = (s: string): string => s.replace(RESERVED, (c) => `\\${c}`);
const TAG_RE = /(^|[^\p{L}\p{N}_&#/])#([\p{L}\p{N}_]{1,60})/gu;

/**
 * The post's text as LinkedIn wants it: every reserved character escaped once (so "(draft)" is not read as markup), except that
 * a #hashtag is written as {hashtag|\#|tag} so it stays a clickable hashtag. Mentions are not supported: "@name" stays plain text.
 */
export function linkedinCommentary(text: string): string {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(TAG_RE)) {
    if (/^\d+$/.test(m[2])) continue; // "#1" is not a hashtag
    const at = (m.index ?? 0) + m[1].length;
    out += escapeLittle(text.slice(last, at)) + `{hashtag|\\#|${m[2].replace(/_/g, '\\_')}}`;
    last = at + 1 + m[2].length;
  }
  return out + escapeLittle(text.slice(last));
}

// ───────────────────────── publishing ─────────────────────────
export type LinkedinSend =
  | { ok: true; id: string }
  | { ok: false; error: string; retryable: boolean; retryAfter?: number };

type SendFailure = Extract<LinkedinSend, { ok: false }>;
const fail = (error: string, retryable: boolean, retryAfter?: number): SendFailure => ({ ok: false, error, retryable, retryAfter });

function failure(e: CallErr): SendFailure {
  if (e.network) return fail('LinkedIn did not answer in time.', true);
  if (e.status === 429) return fail('LinkedIn is rate limiting this account.', true, e.retryAfter);
  if (e.status >= 500) return fail('LinkedIn had a temporary error.', true);
  if (e.status === 401) return fail('LinkedIn no longer accepts the saved sign-in. Reconnect the account.', false);
  if (e.status === 403) return fail('LinkedIn did not allow this post. Reconnect the account and allow Vane to post.', false);
  if (e.status === 426) return fail('LinkedIn no longer supports the API version Vane uses. Please contact support.', false);
  if (e.status === 422 || e.status === 409) return fail(`LinkedIn rejected the post: ${shortMessage(e.data, 'it may be a duplicate of a recent post')}`, false);
  return fail(`LinkedIn rejected the post: ${shortMessage(e.data, `HTTP ${e.status}`)}`, false);
}

const apiHeaders = (token: string, version: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  'Linkedin-Version': version,
  'X-Restli-Protocol-Version': '2.0.0',
});

/** Uploads one picture and returns its urn (urn:li:image:…). */
async function uploadImage(env: LinkedinEnv, creds: LinkedinCreds, mediaUrl: string): Promise<{ ok: true; urn: string } | SendFailure> {
  const img = await downloadImage(mediaUrl, { maxBytes: LINKEDIN_IMAGE_MAX_BYTES, label: 'LinkedIn', maxLabel: '8 MB' });
  if (!img.ok) return fail(img.error, img.retryable);

  const init = await callJson<{ value?: { uploadUrl?: unknown; image?: unknown } }>(`${API}/rest/images?action=initializeUpload`, {
    method: 'POST',
    headers: apiHeaders(creds.accessToken, linkedinVersion(env)),
    json: { initializeUploadRequest: { owner: creds.urn } },
  });
  if (!init.ok) return failure(init);
  const uploadUrl = init.data?.value?.uploadUrl;
  const urn = init.data?.value?.image;
  if (typeof uploadUrl !== 'string' || typeof urn !== 'string' || !/^urn:li:image:[A-Za-z0-9_-]+$/.test(urn)) return fail('LinkedIn did not accept the image.', true);
  let host: string;
  try {
    const u = new URL(uploadUrl);
    if (u.protocol !== 'https:') throw new Error('not https');
    host = u.hostname;
  } catch {
    return fail('LinkedIn gave an upload address Vane does not trust.', false);
  }
  if (!UPLOAD_HOST_RE.test(host)) return fail('LinkedIn gave an upload address Vane does not trust.', false);

  let res: Response;
  try {
    res = await fetch(uploadUrl, { method: 'PUT', headers: { Authorization: `Bearer ${creds.accessToken}`, 'Content-Type': 'application/octet-stream' }, body: img.bytes, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  } catch {
    return fail('LinkedIn did not accept the image in time.', true);
  }
  if (!res.ok) return res.status >= 500 || res.status === 429 ? fail('LinkedIn had a temporary error while uploading the image.', true) : fail(`LinkedIn rejected the image (HTTP ${res.status}).`, false);
  return { ok: true, urn };
}

/**
 * Publishes `content` (and one picture) to the member's profile. A sign-in that has expired fails at once (reconnect), it is not retried.
 */
export async function sendLinkedinPost(env: LinkedinEnv, creds: LinkedinCreds, content: string, mediaUrl: string | undefined, now = Math.floor(Date.now() / 1000)): Promise<LinkedinSend> {
  if (creds.expiresAt && creds.expiresAt <= now) return fail('The LinkedIn sign-in has expired. Reconnect the account.', false);

  const body: Record<string, unknown> = {
    author: creds.urn,
    commentary: linkedinCommentary(content),
    visibility: 'PUBLIC',
    distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
  };
  if (mediaUrl) {
    const up = await uploadImage(env, creds, mediaUrl);
    if (!up.ok) return up;
    body.content = { media: { id: up.urn } };
  }
  const r = await callJson(`${API}/rest/posts`, { method: 'POST', headers: apiHeaders(creds.accessToken, linkedinVersion(env)), json: body, timeoutMs: 20_000 });
  if (!r.ok) return failure(r);
  // 201 Created: the new post's urn is in the x-restli-id header, not in the body.
  const id = r.headers.get('x-restli-id') ?? '';
  return { ok: true, id: /^urn:li:(share|ugcPost):\d{5,30}$/.test(id) ? id : '' };
}
