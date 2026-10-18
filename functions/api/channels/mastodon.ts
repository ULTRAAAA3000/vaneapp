/**
 * Mastodon integration.
 *
 *   normalizeInstance(input, ownHost)            "https://Mastodon.social/@me" → "mastodon.social" (or null when it is not a public server name)
 *   appFor(env, instance, redirectUri)           the OAuth app Vane has on that server: reused, or registered on the fly (POST /api/v1/apps)
 *   authorizeUrl(instance, clientId, ...)        where to send the person to press "Authorize"
 *   exchangeCode(...) / readAccount(...)         code → access token → "who is this?"
 *   sendMastodonPost(creds, content, media, key) POST /api/v1/statuses (+ /api/v2/media for one image)
 *
 * Security notes
 *  - The server name comes from the user, so it is checked hard BEFORE anything is fetched: a plain public DNS name, no port, no
 *    credentials, no IP address, no local-network suffix, not Vane itself. Requests never follow redirects.
 *  - Scopes are the smallest that work: read:accounts (to learn which account was connected), write:statuses, write:media.
 *    Vane cannot read the home timeline, follow, block or change the account.
 *  - The access token and the per-server client secret are stored encrypted (AES-GCM, see ../lib/crypto.ts) and never logged or returned.
 *  - Answers from a server are read with a size cap, so a hostile "server" cannot make us buffer a huge body.
 *  - A post is sent with an Idempotency-Key (the post id): if the answer is lost and the cron worker retries, Mastodon returns the
 *    first status instead of posting twice.
 *
 * This file is NOT a route: it only exports helpers (Pages ignores files without onRequest*).
 */
import type { Env } from '../../../types';
import { decryptToken, encryptToken } from '../lib/crypto';
import { downloadImage } from '../lib/remoteimage';

export const MASTODON_SCOPES = 'read:accounts write:statuses write:media';
export const MASTODON_TEXT_LIMIT = 500;
export const MASTODON_IMAGE_MAX_BYTES = 8_000_000;

const TIMEOUT_MS = 10_000;
const UPLOAD_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 64 * 1024;
const MEDIA_POLLS = 6;

// ───────────────────────── the server name ─────────────────────────
const DOMAIN_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/;
const LOCAL_SUFFIX_RE = /\.(?:local|localhost|internal|intranet|lan|home|corp|private|test|invalid|example)$/;

/**
 * Accepts what people paste: "mastodon.social", "https://mastodon.social/", "https://mastodon.social/@me", "@me@mastodon.social".
 * Returns the bare host, or null when it is not an ordinary public server name.
 */
export function normalizeInstance(input: unknown, ownHost?: string): string | null {
  if (typeof input !== 'string') return null;
  let s = input.trim().toLowerCase();
  if (!s || s.length > 300) return null;
  const handle = /^@?[a-z0-9_.-]+@([^@\s/:\\]+)$/.exec(s);   // @me@mastodon.social
  if (handle) s = handle[1];
  s = s.replace(/^https?:\/\//, '');
  s = s.split(/[/?#]/)[0];
  if (!s || /[@:\s\\]/.test(s)) return null;           // no credentials, port or spaces
  s = s.replace(/\.$/, '');
  if (!DOMAIN_RE.test(s) || LOCAL_SUFFIX_RE.test(s)) return null;
  if (ownHost && s === ownHost.toLowerCase()) return null;
  return s;
}

// ───────────────────────── low-level call ─────────────────────────
type MastoOk<T> = { ok: true; status: number; data: T };
type MastoErr = { ok: false; status: number; message: string; retryAfter?: number; network?: boolean };

/** JSON body, but never more than MAX_BODY_BYTES of it. */
async function readCapped(res: Response): Promise<unknown> {
  const reader = res.body?.getReader();
  if (!reader) return null;
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      parts.push(value);
    }
    const all = new Uint8Array(size);
    let at = 0;
    for (const p of parts) {
      all.set(p, at);
      at += p.length;
    }
    return JSON.parse(new TextDecoder().decode(all));
  } catch {
    return null;
  }
}

function waitFrom(res: Response): number | undefined {
  const ra = Number(res.headers.get('retry-after'));
  if (Number.isFinite(ra) && ra > 0) return Math.ceil(ra);
  const reset = Date.parse(res.headers.get('x-ratelimit-reset') ?? '');
  if (Number.isFinite(reset)) return Math.max(1, Math.ceil((reset - Date.now()) / 1000));
  return undefined;
}

async function call<T>(
  instance: string,
  path: string,
  init: { method?: string; token?: string; json?: unknown; form?: Record<string, string>; multipart?: FormData; headers?: Record<string, string> } = {},
  timeoutMs = TIMEOUT_MS,
): Promise<MastoOk<T> | MastoErr> {
  const headers: Record<string, string> = { Accept: 'application/json', ...init.headers };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  let body: BodyInit | undefined;
  if (init.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.json);
  } else if (init.form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(init.form).toString();
  } else if (init.multipart) {
    body = init.multipart;
  }
  let res: Response;
  try {
    res = await fetch(`https://${instance}${path}`, { method: init.method ?? 'GET', headers, body, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { ok: false, status: 0, message: timedOut ? 'The server did not answer in time' : 'Network error', network: true };
  }
  const data = await readCapped(res);
  if (res.ok) return { ok: true, status: res.status, data: data as T };
  const raw = (data as { error?: unknown } | null)?.error;
  const message = typeof raw === 'string' ? raw.slice(0, 200) : `HTTP ${res.status}`;
  return { ok: false, status: res.status, message, retryAfter: waitFrom(res) };
}

// ───────────────────────── the OAuth app on a server ─────────────────────────
export interface MastodonApp { clientId: string; clientSecret: string }

export type AppResult = { ok: true; app: MastodonApp } | { ok: false; error: string; network: boolean };

/** Vane's app on `instance`: the saved one, or registered right now (dynamic registration). */
export async function appFor(env: Env, instance: string, redirectUri: string): Promise<AppResult> {
  const key = env.ENCRYPTION_KEY!;
  const saved = await env.DB
    .prepare('SELECT client_id, client_secret FROM mastodon_apps WHERE instance = ?1 AND redirect_uri = ?2')
    .bind(instance, redirectUri)
    .first<{ client_id: string; client_secret: string }>();
  if (saved) {
    try {
      return { ok: true, app: { clientId: saved.client_id, clientSecret: await decryptToken(saved.client_secret, key) } };
    } catch {
      /* unreadable (key changed): register again below and overwrite */
    }
  }

  const r = await call<{ client_id?: unknown; client_secret?: unknown }>(instance, '/api/v1/apps', {
    method: 'POST',
    json: { client_name: 'Vane', redirect_uris: redirectUri, scopes: MASTODON_SCOPES, website: 'https://vaneapp.dev' },
  });
  if (!r.ok) {
    return r.network || r.status >= 500
      ? { ok: false, network: true, error: `Could not reach ${instance}. Check the address and try again.` }
      : { ok: false, network: false, error: `${instance} did not accept Vane. Is it a Mastodon server?` };
  }
  const { client_id: clientId, client_secret: clientSecret } = r.data ?? {};
  if (typeof clientId !== 'string' || typeof clientSecret !== 'string' || !clientId || !clientSecret) {
    return { ok: false, network: false, error: `${instance} did not answer like a Mastodon server.` };
  }
  await env.DB
    .prepare(
      `INSERT INTO mastodon_apps (instance, redirect_uri, client_id, client_secret, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(instance, redirect_uri) DO UPDATE SET client_id = ?3, client_secret = ?4, created_at = ?5`,
    )
    .bind(instance, redirectUri, clientId, await encryptToken(clientSecret, key), Math.floor(Date.now() / 1000))
    .run();
  return { ok: true, app: { clientId, clientSecret } };
}

export function authorizeUrl(instance: string, clientId: string, redirectUri: string, state: string): string {
  const q = new URLSearchParams({ client_id: clientId, scope: MASTODON_SCOPES, redirect_uri: redirectUri, response_type: 'code', state });
  return `https://${instance}/oauth/authorize?${q.toString()}`;
}

export type TokenResult = { ok: true; accessToken: string } | { ok: false; error: string };

export async function exchangeCode(instance: string, app: MastodonApp, redirectUri: string, code: string): Promise<TokenResult> {
  const r = await call<{ access_token?: unknown; scope?: unknown }>(instance, '/oauth/token', {
    method: 'POST',
    form: { grant_type: 'authorization_code', code, client_id: app.clientId, client_secret: app.clientSecret, redirect_uri: redirectUri, scope: MASTODON_SCOPES },
  });
  if (!r.ok) return { ok: false, error: `${instance} refused the sign-in (${r.network ? 'no answer' : r.status}).` };
  const token = r.data?.access_token;
  if (typeof token !== 'string' || !token) return { ok: false, error: `${instance} did not return an access token.` };
  const granted = typeof r.data.scope === 'string' ? r.data.scope.split(/\s+/) : [];
  if (!granted.includes('write:statuses') && !granted.includes('write')) return { ok: false, error: 'Vane was not allowed to post. Connect again and press Authorize.' };
  return { ok: true, accessToken: token };
}

export type AccountResult = { ok: true; id: string; username: string } | { ok: false; error: string };

export async function readAccount(instance: string, accessToken: string): Promise<AccountResult> {
  const r = await call<{ id?: unknown; username?: unknown }>(instance, '/api/v1/accounts/verify_credentials', { token: accessToken });
  if (!r.ok) return { ok: false, error: `${instance} would not tell us which account this is.` };
  const { id, username } = r.data ?? {};
  if (typeof id !== 'string' || typeof username !== 'string' || !/^[A-Za-z0-9_.-]{1,60}$/.test(username)) return { ok: false, error: `${instance} did not answer like a Mastodon server.` };
  return { ok: true, id, username };
}

// ───────────────────────── credentials ─────────────────────────
export interface MastodonCreds { instance: string; accountId: string; acct: string; accessToken: string }

export async function loadMastodonCreds(encrypted: string, encryptionKey: string | undefined): Promise<MastodonCreds | null> {
  if (!encryptionKey) return null;
  try {
    const p = JSON.parse(await decryptToken(encrypted, encryptionKey));
    if (typeof p?.instance !== 'string' || typeof p?.accessToken !== 'string' || typeof p?.accountId !== 'string') return null;
    if (!normalizeInstance(p.instance)) return null;   // never call a host that would not pass today's checks
    return { instance: p.instance, accountId: p.accountId, acct: String(p.acct ?? ''), accessToken: p.accessToken };
  } catch {
    return null;
  }
}

/** Does this user already have this account connected? Returns the channel's display name, or null. */
export async function findDuplicateMastodonChannel(db: D1Database, encryptionKey: string | undefined, userId: string, instance: string, accountId: string): Promise<string | null> {
  const { results } = await db
    .prepare(`SELECT name, credentials FROM channels WHERE user_id = ?1 AND type = 'mastodon' LIMIT 200`)
    .bind(userId)
    .all<{ name: string; credentials: string }>();
  for (const row of results) {
    const c = await loadMastodonCreds(row.credentials, encryptionKey);
    if (c && c.instance === instance && c.accountId === accountId) return row.name;
  }
  return null;
}

// ───────────────────────── send ─────────────────────────
export type MastodonSend =
  | { ok: true; url: string }
  | { ok: false; error: string; retryable: boolean; retryAfter?: number };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function failure(e: MastoErr): { ok: false; error: string; retryable: boolean; retryAfter?: number } {
  if (e.network) return { ok: false, error: e.message, retryable: true };
  if (e.status === 429) return { ok: false, error: 'The Mastodon server is rate limiting this account.', retryable: true, retryAfter: e.retryAfter };
  if (e.status >= 500) return { ok: false, error: 'The Mastodon server had a temporary error.', retryable: true };
  if (e.status === 401 || e.status === 403) return { ok: false, error: 'The Mastodon server no longer accepts the saved sign-in. Reconnect the account.', retryable: false };
  return { ok: false, error: `The Mastodon server rejected the post: ${e.message}`, retryable: false };
}

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

/** Uploads one image and waits until the server has processed it. Returns the media id. */
async function uploadImage(creds: MastodonCreds, mediaUrl: string): Promise<{ ok: true; id: string } | { ok: false; error: string; retryable: boolean; retryAfter?: number }> {
  const img = await downloadImage(mediaUrl, { maxBytes: MASTODON_IMAGE_MAX_BYTES, label: 'Mastodon', maxLabel: '8 MB' });
  if (!img.ok) return { ok: false, error: img.error, retryable: img.retryable };

  const form = new FormData();
  form.append('file', new Blob([img.bytes], { type: img.contentType }), `image.${EXT[img.contentType] ?? 'jpg'}`);
  const up = await call<{ id?: unknown }>(creds.instance, '/api/v2/media', { method: 'POST', token: creds.accessToken, multipart: form }, UPLOAD_TIMEOUT_MS);
  if (!up.ok) return failure(up);
  const id = up.data?.id;
  if (typeof id !== 'string' || !id) return { ok: false, error: 'The Mastodon server did not accept the image.', retryable: true };

  // 200 = ready, 202 = still being processed: ask until it is ready
  let status = up.status;
  for (let i = 0; status === 202 && i < MEDIA_POLLS; i++) {
    await sleep(1000);
    const poll = await call<unknown>(creds.instance, `/api/v1/media/${encodeURIComponent(id)}`, { token: creds.accessToken });
    if (!poll.ok) return failure(poll);
    status = poll.status;
  }
  if (status === 202 || status === 206) return { ok: false, error: 'The Mastodon server is still processing the image.', retryable: true };
  return { ok: true, id };
}

export async function sendMastodonPost(creds: MastodonCreds, content: string, mediaUrl: string | undefined, idempotencyKey: string): Promise<MastodonSend> {
  const body: Record<string, unknown> = { status: content, visibility: 'public' };
  if (mediaUrl) {
    const up = await uploadImage(creds, mediaUrl);
    if (!up.ok) return up;
    body.media_ids = [up.id];
  }
  const r = await call<{ url?: unknown; id?: unknown }>(creds.instance, '/api/v1/statuses', {
    method: 'POST', token: creds.accessToken, json: body, headers: { 'Idempotency-Key': idempotencyKey },
  });
  if (!r.ok) return failure(r);
  const url = typeof r.data?.url === 'string' ? r.data.url : typeof r.data?.id === 'string' ? r.data.id : '';
  return { ok: true, url };
}
