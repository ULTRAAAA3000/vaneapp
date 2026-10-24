/**
 * Reddit integration (OAuth2 "web app", host oauth.reddit.com). One Vane channel = one Reddit account posting to ONE subreddit
 * (the person names it when connecting; the same account can have several channels, one per subreddit).
 *
 *   redditConfigured(env)                      REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET set? (the connect button is off until they are)
 *   authorizeUrl(env, redirectUri, state)      where the person presses "Allow" (permanent duration, scopes identity + submit only)
 *   exchangeCode(env, redirectUri, code, now)  code → access token (1 hour) + refresh token (does not expire until revoked)
 *   readProfile(accessToken)                   "who is this?" → username
 *   refreshRedditToken(env, creds, now)        refresh token → a new access token
 *   sendRedditPost(creds, content, mediaUrl)   POST /api/submit as a text post: the first line is the title, the rest the body
 *
 * Security: scopes are only `identity` and `submit`; tokens are stored encrypted (AES-GCM) and never logged. Reddit requires a
 * descriptive User-Agent on every call. This file is NOT a route.
 */
import { decryptToken } from '../lib/crypto';
import { callJson, shortMessage } from '../lib/httpcall';

export const REDDIT_TITLE_LIMIT = 300;
export const REDDIT_BODY_LIMIT = 10_000;
const UA = 'web:dev.vaneapp.post:1.0 (by /u/vaneapp)';
const AUTH = 'https://www.reddit.com/api/v1/authorize';
const TOKEN = 'https://www.reddit.com/api/v1/access_token';
const API = 'https://oauth.reddit.com';

export interface RedditEnv { REDDIT_CLIENT_ID?: string; REDDIT_CLIENT_SECRET?: string }
export const redditConfigured = (env: RedditEnv): boolean => Boolean(env.REDDIT_CLIENT_ID && env.REDDIT_CLIENT_SECRET);
const basic = (env: RedditEnv): string => `Basic ${btoa(`${env.REDDIT_CLIENT_ID ?? ''}:${env.REDDIT_CLIENT_SECRET ?? ''}`)}`;

/** "r/Foo", "/r/foo" or "foo" → "foo" (2 to 21 letters, digits, underscore), or null. */
export function cleanSubreddit(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/^\/?r\//i, '');
  return /^[A-Za-z0-9_]{2,21}$/.test(s) ? s : null;
}

/** The post's title (first line) and body (the rest). */
export function splitPost(content: string): { title: string; text: string } {
  const lines = content.replace(/\r\n/g, '\n').trim().split('\n');
  const title = (lines[0] ?? '').replace(/^#+\s*/, '').trim();
  return { title, text: lines.slice(1).join('\n').trim() };
}

export function authorizeUrl(env: RedditEnv, redirectUri: string, state: string): string {
  return `${AUTH}?${new URLSearchParams({ client_id: env.REDDIT_CLIENT_ID ?? '', response_type: 'code', state, redirect_uri: redirectUri, duration: 'permanent', scope: 'identity submit' }).toString()}`;
}

export interface RedditTokens { accessToken: string; refreshToken: string; expiresAt: number }
export type ConnectResult = { ok: true; tokens: RedditTokens } | { ok: false; reason: 'failed' | 'noperm' };

export async function exchangeCode(env: RedditEnv, redirectUri: string, code: string, now: number): Promise<ConnectResult> {
  const r = await callJson<{ access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; scope?: unknown; error?: unknown }>(TOKEN, {
    method: 'POST', headers: { Authorization: basic(env), 'User-Agent': UA }, form: { grant_type: 'authorization_code', code, redirect_uri: redirectUri },
  });
  if (!r.ok || r.data?.error) return { ok: false, reason: 'failed' };
  const { access_token: a, refresh_token: rt, scope } = r.data ?? {};
  if (typeof a !== 'string' || !a || typeof rt !== 'string' || !rt) return { ok: false, reason: 'failed' };
  if (typeof scope === 'string' && !scope.split(' ').includes('submit')) return { ok: false, reason: 'noperm' };
  const life = typeof r.data?.expires_in === 'number' && r.data.expires_in > 0 ? r.data.expires_in : 3600;
  return { ok: true, tokens: { accessToken: a, refreshToken: rt, expiresAt: now + life } };
}

export type ProfileResult = { ok: true; username: string } | { ok: false };
export async function readProfile(accessToken: string): Promise<ProfileResult> {
  const r = await callJson<{ name?: unknown }>(`${API}/api/v1/me`, { headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': UA } });
  const name = r.ok ? r.data?.name : undefined;
  return typeof name === 'string' && /^[A-Za-z0-9_-]{3,30}$/.test(name) ? { ok: true, username: name } : { ok: false };
}

// ───────────────────────── credentials ─────────────────────────
export interface RedditCreds { username: string; subreddit: string; accessToken: string; refreshToken: string; expiresAt: number }

export const redditBlob = (c: RedditCreds): Record<string, unknown> => ({ type: 'reddit', username: c.username, subreddit: c.subreddit, accessToken: c.accessToken, refreshToken: c.refreshToken, expiresAt: c.expiresAt });
export const redditIdentityOf = (username: string, subreddit: string): string => `${username.toLowerCase()}|${subreddit.toLowerCase()}`;

export async function loadRedditCreds(encrypted: string, key: string | undefined): Promise<RedditCreds | null> {
  if (!key) return null;
  try {
    const p = JSON.parse(await decryptToken(encrypted, key));
    if (typeof p?.refreshToken !== 'string' || !p.refreshToken || !cleanSubreddit(p?.subreddit)) return null;
    return { username: String(p.username ?? ''), subreddit: p.subreddit, accessToken: String(p.accessToken ?? ''), refreshToken: p.refreshToken, expiresAt: typeof p.expiresAt === 'number' ? p.expiresAt : 0 };
  } catch {
    return null;
  }
}

export async function redditIdentity(encrypted: string, key: string | undefined): Promise<string | null> {
  const c = await loadRedditCreds(encrypted, key);
  return c ? redditIdentityOf(c.username, c.subreddit) : null;
}

/** A fresh access token (good for an hour), or null when Reddit refuses the refresh token (revoked) or does not answer. */
export async function refreshRedditToken(env: RedditEnv, creds: RedditCreds, now: number): Promise<{ ok: true; creds: RedditCreds } | { ok: false; revoked: boolean }> {
  const r = await callJson<{ access_token?: unknown; expires_in?: unknown; error?: unknown }>(TOKEN, {
    method: 'POST', headers: { Authorization: basic(env), 'User-Agent': UA }, form: { grant_type: 'refresh_token', refresh_token: creds.refreshToken },
  });
  if (!r.ok) return { ok: false, revoked: r.status === 400 || r.status === 401 || r.status === 403 };
  if (r.data?.error) return { ok: false, revoked: r.data.error === 'invalid_grant' };
  const a = r.data?.access_token;
  if (typeof a !== 'string' || !a) return { ok: false, revoked: false };
  const life = typeof r.data?.expires_in === 'number' && r.data.expires_in > 0 ? r.data.expires_in : 3600;
  return { ok: true, creds: { ...creds, accessToken: a, expiresAt: now + life } };
}

// ───────────────────────── publishing ─────────────────────────
export type RedditSend = { ok: true; id: string; url: string } | { ok: false; error: string; retryable: boolean; retryAfter?: number };
const fail = (error: string, retryable: boolean, retryAfter?: number): Extract<RedditSend, { ok: false }> => ({ ok: false, error, retryable, retryAfter });

/** Reddit's rate-limit text: "you are doing that too much. try again in 9 minutes." → seconds. */
function waitFromText(t: string): number | undefined {
  const m = /(\d+)\s*(second|minute|hour)/i.exec(t);
  if (!m) return undefined;
  return Number(m[1]) * ({ second: 1, minute: 60, hour: 3600 }[m[2].toLowerCase() as 'second'] ?? 60);
}

export async function sendRedditPost(creds: RedditCreds, content: string, mediaUrl: string | undefined): Promise<RedditSend> {
  const { title, text } = splitPost(content);
  if (!title) return fail('A Reddit post needs a title: put it on the first line.', false);
  if (title.length > REDDIT_TITLE_LIMIT) return fail(`The first line is the Reddit title and can be at most ${REDDIT_TITLE_LIMIT} characters (it has ${title.length}).`, false);
  const body = mediaUrl ? `${text}${text ? '\n\n' : ''}${mediaUrl}` : text;

  const r = await callJson<{ json?: { errors?: unknown[][]; data?: { url?: unknown; id?: unknown } } }>(`${API}/api/submit`, {
    method: 'POST', headers: { Authorization: `Bearer ${creds.accessToken}`, 'User-Agent': UA },
    form: { api_type: 'json', kind: 'self', sr: creds.subreddit, title, text: body, resubmit: 'true', sendreplies: 'false' }, timeoutMs: 20_000,
  });
  if (!r.ok) {
    if (r.network || r.status >= 500) return fail('Reddit did not answer in time.', true);
    if (r.status === 429) return fail('Reddit is rate limiting this account.', true, r.retryAfter);
    if (r.status === 401) return fail('Reddit no longer accepts the saved sign-in. Reconnect the account.', false);
    if (r.status === 403) return fail(`Reddit does not let this account post in r/${creds.subreddit}.`, false);
    return fail(`Reddit rejected the post: ${shortMessage(r.data, `HTTP ${r.status}`)}`, false);
  }
  const errors = r.data?.json?.errors;
  if (Array.isArray(errors) && errors.length) {
    const [code, message] = errors[0] as [string, string];
    const msg = typeof message === 'string' ? message.slice(0, 200) : 'Reddit refused the post.';
    if (code === 'RATELIMIT') return fail(`Reddit asks to slow down: ${msg}`, true, waitFromText(msg) ?? 600);
    if (code === 'SUBREDDIT_NOEXIST' || code === 'SUBREDDIT_NOTALLOWED' || code === 'SUBREDDIT_NOTALLOWED_BANNED') return fail(`r/${creds.subreddit}: ${msg}`, false);
    if (code === 'INVALID_OPTION' || code === 'USER_REQUIRED') return fail('Reddit no longer accepts the saved sign-in. Reconnect the account.', false);
    return fail(`Reddit refused the post (${String(code).slice(0, 40)}): ${msg}`, false);
  }
  const d = r.data?.json?.data;
  const url = typeof d?.url === 'string' && d.url.startsWith('https://') ? d.url : '';
  return { ok: true, id: typeof d?.id === 'string' ? d.id : '', url };
}
