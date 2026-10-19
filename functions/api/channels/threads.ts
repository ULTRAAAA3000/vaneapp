/**
 * Threads integration (Meta's Threads API, host graph.threads.net: NOT the Instagram / Facebook Graph API).
 *
 *   threadsConfigured(env)                       are THREADS_APP_ID / THREADS_APP_SECRET set? (the connect button is off until they are)
 *   authorizeUrl(env, redirectUri, state)        where to send the person to press "Allow"
 *   exchangeCode(env, redirectUri, code)         code → short-lived token → long-lived token (60 days) + the Threads user id
 *   readProfile(token)                           "who is this?" → username
 *   refreshThreadsToken(creds, now)              long-lived token → a new one (another 60 days); Meta allows it once the token is a day old
 *   sendThreadsPost(creds, content, media)       POST /{user}/threads (container) → wait until ready → POST /{user}/threads_publish
 *   parseSignedRequest(signed, secret)           Meta's deauthorize / data-deletion calls (signed with the app secret)
 *
 * Security notes
 *  - Scopes are the smallest that work: threads_basic (which profile is this) and threads_content_publish (publish posts).
 *  - The long-lived token is stored encrypted (AES-GCM, see ../lib/crypto.ts), never logged or returned. The token endpoints of
 *    Meta take the secret / token in the query string; those URLs are only ever fetched, never stored or logged.
 *  - Meta's deauthorize / data-deletion calls are only believed when their HMAC-SHA256 signature checks out against the app secret.
 *  - The picture or video is fetched by Meta from its public https address: nothing is uploaded from here.
 *
 * This file is NOT a route: it only exports helpers (Pages ignores files without onRequest*).
 */
import { decryptToken } from '../lib/crypto';
import { fromB64Url } from '../lib/encoding';
import { callJson, shortMessage, type CallErr } from '../lib/httpcall';
import { mediaKindFromUrl } from '../lib/media';

export const THREADS_SCOPES = 'threads_basic,threads_content_publish';
export const THREADS_TEXT_LIMIT = 500;
/** Renew a token that has less than this left */
export const THREADS_RENEW_BEFORE_SECONDS = 20 * 24 * 3600;

const AUTHORIZE = 'https://threads.net/oauth/authorize';
const API = 'https://graph.threads.net';
const CONTAINER_POLLS = 8;
const CONTAINER_POLL_MS = 2000;

export interface ThreadsEnv { THREADS_APP_ID?: string; THREADS_APP_SECRET?: string }

export const threadsConfigured = (env: ThreadsEnv): boolean => Boolean(env.THREADS_APP_ID && env.THREADS_APP_SECRET);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────── sign-in ─────────────────────────
export function authorizeUrl(env: ThreadsEnv, redirectUri: string, state: string): string {
  const q = new URLSearchParams({ client_id: env.THREADS_APP_ID ?? '', redirect_uri: redirectUri, scope: THREADS_SCOPES, response_type: 'code', state });
  return `${AUTHORIZE}?${q.toString()}`;
}

export interface ThreadsConnected { userId: string; accessToken: string; expiresAt: number }
export type ConnectResult = { ok: true; connected: ThreadsConnected } | { ok: false; reason: 'failed' | 'noperm' };

/** The whole code → long-lived token step. Threads hands back the user id together with the short-lived token. */
export async function exchangeCode(env: ThreadsEnv, redirectUri: string, code: string, now = Math.floor(Date.now() / 1000)): Promise<ConnectResult> {
  const short = await callJson<{ access_token?: unknown; user_id?: unknown }>(`${API}/oauth/access_token`, {
    method: 'POST',
    form: { client_id: env.THREADS_APP_ID ?? '', client_secret: env.THREADS_APP_SECRET ?? '', grant_type: 'authorization_code', redirect_uri: redirectUri, code },
  });
  if (!short.ok) return { ok: false, reason: 'failed' };
  const token = short.data?.access_token;
  const userId = short.data?.user_id === undefined ? '' : String(short.data.user_id);
  if (typeof token !== 'string' || !token || !/^\d{3,30}$/.test(userId)) return { ok: false, reason: 'failed' };

  const long = await callJson<{ access_token?: unknown; expires_in?: unknown }>(
    `${API}/access_token?${new URLSearchParams({ grant_type: 'th_exchange_token', client_secret: env.THREADS_APP_SECRET ?? '', access_token: token }).toString()}`,
  );
  if (!long.ok) return { ok: false, reason: 'failed' };
  const longToken = long.data?.access_token;
  if (typeof longToken !== 'string' || !longToken) return { ok: false, reason: 'failed' };
  const life = typeof long.data.expires_in === 'number' && long.data.expires_in > 0 ? long.data.expires_in : 60 * 24 * 3600;
  return { ok: true, connected: { userId, accessToken: longToken, expiresAt: now + life } };
}

export type ProfileResult = { ok: true; username: string } | { ok: false };

export async function readProfile(accessToken: string): Promise<ProfileResult> {
  const r = await callJson<{ username?: unknown }>(`${API}/v1.0/me?fields=id,username`, { headers: { Authorization: `Bearer ${accessToken}` } });
  const name = r.ok ? r.data?.username : undefined;
  return typeof name === 'string' && /^[A-Za-z0-9_.]{1,60}$/.test(name) ? { ok: true, username: name } : { ok: false };
}

// ───────────────────────── credentials ─────────────────────────
export interface ThreadsCreds { userId: string; username: string; accessToken: string; expiresAt: number }

export const threadsBlob = (c: ThreadsCreds): Record<string, unknown> => ({ type: 'threads', userId: c.userId, username: c.username, accessToken: c.accessToken, expiresAt: c.expiresAt });

export async function loadThreadsCreds(encrypted: string, encryptionKey: string | undefined): Promise<ThreadsCreds | null> {
  if (!encryptionKey) return null;
  try {
    const p = JSON.parse(await decryptToken(encrypted, encryptionKey));
    if (typeof p?.accessToken !== 'string' || !p.accessToken || typeof p?.userId !== 'string' || !/^\d{3,30}$/.test(p.userId)) return null;
    return { userId: p.userId, username: typeof p.username === 'string' ? p.username : '', accessToken: p.accessToken, expiresAt: typeof p.expiresAt === 'number' ? p.expiresAt : 0 };
  } catch {
    return null;
  }
}

/**
 * Which Threads account a saved channel belongs to, even when its token has been wiped (after Meta's "deauthorize"). Used to find
 * the channel again for a data-deletion request or when the person connects the same account again.
 */
export async function threadsIdentity(encrypted: string, encryptionKey: string | undefined): Promise<string | null> {
  if (!encryptionKey) return null;
  try {
    const p = JSON.parse(await decryptToken(encrypted, encryptionKey));
    return typeof p?.userId === 'string' && /^\d{3,30}$/.test(p.userId) ? p.userId : null;
  } catch {
    return null;
  }
}

/** A fresh long-lived token (60 more days), or null (too young, expired, revoked, no answer). */
export async function refreshThreadsToken(creds: ThreadsCreds, now: number): Promise<ThreadsCreds | null> {
  const r = await callJson<{ access_token?: unknown; expires_in?: unknown }>(
    `${API}/refresh_access_token?${new URLSearchParams({ grant_type: 'th_refresh_token', access_token: creds.accessToken }).toString()}`,
  );
  if (!r.ok) return null;
  const token = r.data?.access_token;
  if (typeof token !== 'string' || !token) return null;
  const life = typeof r.data.expires_in === 'number' && r.data.expires_in > 0 ? r.data.expires_in : 60 * 24 * 3600;
  return { ...creds, accessToken: token, expiresAt: now + life };
}

// ───────────────────────── Meta's signed calls ─────────────────────────
/**
 * Meta calls the deauthorize and data-deletion addresses with a form field `signed_request` = base64url(signature) "." base64url(JSON),
 * signed with HMAC-SHA256 over the second part using the app secret. Returns the user id, or null when anything is off.
 */
export async function parseSignedRequest(signed: unknown, appSecret: string | undefined): Promise<string | null> {
  if (typeof signed !== 'string' || !appSecret || signed.length > 4096) return null;
  const dot = signed.indexOf('.');
  if (dot < 1 || signed.indexOf('.', dot + 1) !== -1) return null;
  const payloadPart = signed.slice(dot + 1);
  try {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(appSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const good = await crypto.subtle.verify('HMAC', key, fromB64Url(signed.slice(0, dot)), new TextEncoder().encode(payloadPart));
    if (!good) return null;
    const payload = JSON.parse(new TextDecoder().decode(fromB64Url(payloadPart))) as { algorithm?: unknown; user_id?: unknown };
    if (String(payload.algorithm).toUpperCase() !== 'HMAC-SHA256') return null;
    const id = payload.user_id === undefined ? '' : String(payload.user_id);
    return /^\d{3,30}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

// ───────────────────────── publishing ─────────────────────────
export type ThreadsSend =
  | { ok: true; id: string; url: string }
  | { ok: false; error: string; retryable: boolean; retryAfter?: number };

const fail = (error: string, retryable: boolean, retryAfter?: number): Extract<ThreadsSend, { ok: false }> => ({ ok: false, error, retryable, retryAfter });

const RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);

function failure(e: CallErr): Extract<ThreadsSend, { ok: false }> {
  const err = (e.data as { error?: { code?: unknown; type?: unknown } } | null)?.error;
  const code = typeof err?.code === 'number' ? err.code : 0;
  if (e.network) return fail('Threads did not answer in time.', true);
  if (e.status === 429 || RATE_LIMIT_CODES.has(code)) return fail('Threads is rate limiting this account.', true, e.retryAfter);
  if (e.status >= 500) return fail('Threads had a temporary error.', true);
  if (code === 190 || e.status === 401) return fail('Threads no longer accepts the saved sign-in. Reconnect the account.', false);
  if (e.status === 403) return fail('Threads did not allow this post. Reconnect the account and allow Vane to publish.', false);
  return fail(`Threads rejected the post: ${shortMessage(e.data, `HTTP ${e.status}`)}`, false);
}

/**
 * Publishes a text post, or a post with one picture or video. Meta fetches the media itself from `mediaUrl` (a public https address).
 * Creating the container is harmless to repeat; only the last call publishes, so a retry after an early failure never doubles a post.
 */
export async function sendThreadsPost(creds: ThreadsCreds, content: string, mediaUrl: string | undefined, now = Math.floor(Date.now() / 1000), pollMs = CONTAINER_POLL_MS): Promise<ThreadsSend> {
  if (creds.expiresAt && creds.expiresAt <= now) return fail('The Threads sign-in has expired. Reconnect the account.', false);
  const auth = { Authorization: `Bearer ${creds.accessToken}` };

  const form: Record<string, string> = { text: content };
  if (mediaUrl) {
    const video = mediaKindFromUrl(mediaUrl) === 'video';
    form.media_type = video ? 'VIDEO' : 'IMAGE';
    form[video ? 'video_url' : 'image_url'] = mediaUrl;
  } else {
    form.media_type = 'TEXT';
  }
  const made = await callJson<{ id?: unknown }>(`${API}/v1.0/${creds.userId}/threads`, { method: 'POST', headers: auth, form, timeoutMs: 20_000 });
  if (!made.ok) return failure(made);
  const container = made.data?.id;
  if (typeof container !== 'string' || !/^\d{3,40}$/.test(container)) return fail('Threads did not accept the post.', true);

  // Wait until Threads has processed it (instant for text, seconds for a picture, longer for a video).
  let ready = false;
  for (let i = 0; i < CONTAINER_POLLS && !ready; i++) {
    const s = await callJson<{ status?: unknown; error_message?: unknown }>(`${API}/v1.0/${container}?fields=status,error_message`, { headers: auth });
    if (s.ok) {
      const status = String(s.data?.status ?? '');
      if (status === 'FINISHED') ready = true;
      else if (status === 'ERROR' || status === 'EXPIRED') {
        return fail(`Threads could not process the post${typeof s.data?.error_message === 'string' && s.data.error_message ? `: ${shortMessage({ message: s.data.error_message }, '')}` : '.'}`, false);
      }
    } else if (s.status >= 400 && s.status < 500 && s.status !== 429) {
      return failure(s);
    }
    if (!ready && i < CONTAINER_POLLS - 1) await sleep(pollMs);
  }
  if (!ready) return fail('Threads is still processing the post.', true);

  const pub = await callJson<{ id?: unknown }>(`${API}/v1.0/${creds.userId}/threads_publish`, { method: 'POST', headers: auth, form: { creation_id: container }, timeoutMs: 20_000 });
  if (!pub.ok) return failure(pub);
  const id = pub.data?.id;
  if (typeof id !== 'string' || !id) return { ok: true, id: '', url: '' };

  // The public link; the post is already live, so a failure here is not an error.
  const link = await callJson<{ permalink?: unknown }>(`${API}/v1.0/${id}?fields=permalink`, { headers: auth });
  const permalink = link.ok && typeof link.data?.permalink === 'string' ? link.data.permalink : '';
  return { ok: true, id, url: permalink };
}
