/**
 * Bluesky (AT Protocol) integration.
 *
 *   validateBlueskyAccount(identifier, appPassword)  → is this a real account, and does the app password work?
 *   openBlueskySession(creds)                        → a short-lived session (the cron worker opens one per channel per run)
 *   sendBlueskyPost(session, content, mediaUrl?)     → app.bsky.feed.post, with links made clickable and one image
 *   loadBlueskyCreds(encrypted, encryptionKey)       → decrypts what handleAddChannel saved
 *
 * Security notes
 *  - Only an APP PASSWORD is ever accepted (Bluesky → Settings → Privacy and security → App passwords).
 *    A normal account password has a different shape and is refused, so a user can't hand us the key to their whole account by mistake.
 *    An app password cannot change the account, reach DMs or manage other app passwords, and the user can revoke it any time.
 *  - The app password is stored encrypted like every channel secret and is never logged or returned.
 *  - Only the official service (bsky.social) is called. A user-supplied server address would turn this into a request-forwarding tool.
 *  - Every call has a hard timeout so a slow Bluesky can't hang a request or the cron worker.
 *
 * This file is NOT a route: it only exports helpers (Pages ignores files without onRequest*).
 */
import { decryptToken } from '../lib/crypto';
import { utf8Length } from '../lib/text';
import { isValidMediaUrl } from './telegram';

export const BLUESKY_SERVICE = 'https://bsky.social';
export const BLUESKY_TEXT_LIMIT = 300;        // graphemes
export const BLUESKY_TEXT_MAX_BYTES = 3000;   // the protocol also caps the UTF-8 size
export const BLUESKY_IMAGE_MAX_BYTES = 1_000_000;

const TIMEOUT_MS = 10_000;
const IMAGE_TIMEOUT_MS = 20_000;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

// ───────────────────────── input validation ─────────────────────────
const APP_PASSWORD_RE = /^[a-z0-9]{4}(?:-[a-z0-9]{4}){3}$/i;
const HANDLE_RE = /^(?=.{3,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export const isAppPassword = (v: unknown): v is string => typeof v === 'string' && APP_PASSWORD_RE.test(v.trim());

/** "@Alice.bsky.social", "alice.bsky.social" or a pasted bsky.app profile link → "alice.bsky.social". */
export function normalizeHandle(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  let s = v.trim().toLowerCase();
  const link = /^(?:https?:\/\/)?bsky\.app\/profile\/([^/?#]+)\/?$/.exec(s);
  if (link) s = link[1];
  s = s.replace(/^@/, '');
  return HANDLE_RE.test(s) ? s : null;
}

// ───────────────────────── low-level call ─────────────────────────
type BskyOk<T> = { ok: true; data: T };
type BskyErr = { ok: false; status: number; message: string; retryAfter?: number; network?: boolean };

/** Seconds to wait, from the standard Retry-After header or Bluesky's ratelimit-reset (an epoch second). */
function waitFrom(res: Response): number | undefined {
  const ra = Number(res.headers.get('retry-after'));
  if (Number.isFinite(ra) && ra > 0) return Math.ceil(ra);
  const reset = Number(res.headers.get('ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) return Math.max(1, Math.ceil(reset - Date.now() / 1000));
  return undefined;
}

async function xrpc<T>(
  nsid: string,
  init: { jwt?: string; json?: unknown; bytes?: ArrayBuffer; contentType?: string },
  timeoutMs = TIMEOUT_MS,
): Promise<BskyOk<T> | BskyErr> {
  const headers: Record<string, string> = {};
  if (init.jwt) headers.Authorization = `Bearer ${init.jwt}`;
  let body: BodyInit | undefined;
  if (init.bytes) {
    headers['Content-Type'] = init.contentType ?? 'application/octet-stream';
    body = init.bytes;
  } else if (init.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.json);
  }
  let res: Response;
  try {
    res = await fetch(`${BLUESKY_SERVICE}/xrpc/${nsid}`, { method: 'POST', headers, body, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { ok: false, status: 0, message: timedOut ? 'Bluesky did not answer in time' : 'Network error', network: true };
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON error page */
  }
  if (res.ok) return { ok: true, data: data as T };
  const message = typeof (data as { message?: unknown } | null)?.message === 'string' ? (data as { message: string }).message : `HTTP ${res.status}`;
  return { ok: false, status: res.status, message: message.slice(0, 200), retryAfter: waitFrom(res) };
}

// ───────────────────────── sessions ─────────────────────────
export interface BlueskyCreds { identifier: string; did: string; appPassword: string }
export interface BlueskySession { did: string; handle: string; jwt: string }

export type SessionResult =
  | { ok: true; session: BlueskySession }
  | { ok: false; code: 'bad_login' | 'rate_limited' | 'network'; error: string; retryAfter?: number };

export async function openBlueskySession(identifier: string, appPassword: string): Promise<SessionResult> {
  const r = await xrpc<{ accessJwt: string; did: string; handle: string }>('com.atproto.server.createSession', { json: { identifier, password: appPassword } });
  if (r.ok) return { ok: true, session: { did: r.data.did, handle: r.data.handle, jwt: r.data.accessJwt } };
  if (r.network || r.status >= 500) return { ok: false, code: 'network', error: 'Could not reach Bluesky. Try again in a moment.' };
  if (r.status === 429) return { ok: false, code: 'rate_limited', error: 'Bluesky is rate limiting sign-ins. Try again shortly.', retryAfter: r.retryAfter };
  return { ok: false, code: 'bad_login', error: 'Bluesky did not accept this handle and app password.' };
}

export type BlueskyValidation =
  | { ok: true; did: string; handle: string }
  | { ok: false; code: 'bad_input' | 'bad_login' | 'rate_limited' | 'network'; error: string };

export async function validateBlueskyAccount(identifier: unknown, appPassword: unknown): Promise<BlueskyValidation> {
  const handle = normalizeHandle(identifier);
  if (!handle) return { ok: false, code: 'bad_input', error: 'Enter your Bluesky handle, like alice.bsky.social.' };
  if (!isAppPassword(appPassword)) {
    return { ok: false, code: 'bad_input', error: 'That is not an app password. Create one in Bluesky → Settings → Privacy and security → App passwords. It looks like xxxx-xxxx-xxxx-xxxx. Never use your normal password.' };
  }
  const s = await openBlueskySession(handle, appPassword.trim());
  if (!s.ok) return { ok: false, code: s.code, error: s.error };
  return { ok: true, did: s.session.did, handle: s.session.handle };
}

// ───────────────────────── credentials ─────────────────────────
export async function loadBlueskyCreds(encrypted: string, encryptionKey: string | undefined): Promise<BlueskyCreds | null> {
  if (!encryptionKey) return null;
  try {
    const p = JSON.parse(await decryptToken(encrypted, encryptionKey));
    if (typeof p?.identifier !== 'string' || typeof p?.did !== 'string' || typeof p?.appPassword !== 'string') return null;
    return { identifier: p.identifier, did: p.did, appPassword: p.appPassword };
  } catch {
    return null;
  }
}

/** Does this user already have this account connected? Returns the channel's display name, or null. */
export async function findDuplicateBlueskyChannel(db: D1Database, encryptionKey: string | undefined, userId: string, did: string): Promise<string | null> {
  const { results } = await db
    .prepare(`SELECT name, credentials FROM channels WHERE user_id = ?1 AND type = 'bluesky' LIMIT 200`)
    .bind(userId)
    .all<{ name: string; credentials: string }>();
  for (const row of results) {
    const c = await loadBlueskyCreds(row.credentials, encryptionKey);
    if (c && c.did === did) return row.name;
  }
  return null;
}

// ───────────────────────── rich text ─────────────────────────
interface Facet {
  index: { byteStart: number; byteEnd: number };
  features: ({ $type: 'app.bsky.richtext.facet#link'; uri: string } | { $type: 'app.bsky.richtext.facet#tag'; tag: string })[];
}

const enc = new TextEncoder();
const URL_RE = /https?:\/\/[^\s]+/g;
const TAG_RE = /(^|\s)#([^\s#.,;:!?'"()[\]{}<>]{1,63})/g;

/**
 * Bluesky does not turn links or #tags into links by itself: the post must say which byte ranges are links.
 * Offsets are UTF-8 BYTES, not characters (that is how the protocol counts).
 */
export function buildFacets(text: string): Facet[] {
  const facets: Facet[] = [];
  const byteOffset = (charIndex: number) => enc.encode(text.slice(0, charIndex)).length;

  for (const m of text.matchAll(URL_RE)) {
    const uri = m[0].replace(/[.,;:!?)\]}'"]+$/, '');   // a full stop after a link is not part of it
    try {
      new URL(uri);
    } catch {
      continue;
    }
    const start = m.index!;
    facets.push({ index: { byteStart: byteOffset(start), byteEnd: byteOffset(start + uri.length) }, features: [{ $type: 'app.bsky.richtext.facet#link', uri }] });
  }
  for (const m of text.matchAll(TAG_RE)) {
    const start = m.index! + m[1].length;
    const end = start + 1 + m[2].length;
    if (facets.some((f) => f.index.byteStart < byteOffset(end) && byteOffset(start) < f.index.byteEnd)) continue;   // inside a link
    if (/^\d+$/.test(m[2])) continue;                                                                                // "#1" is a number, not a tag
    facets.push({ index: { byteStart: byteOffset(start), byteEnd: byteOffset(end) }, features: [{ $type: 'app.bsky.richtext.facet#tag', tag: m[2] }] });
  }
  return facets.sort((a, b) => a.index.byteStart - b.index.byteStart);
}

// ───────────────────────── image ─────────────────────────
type ImageResult = { ok: true; bytes: ArrayBuffer; contentType: string } | { ok: false; error: string; retryable: boolean };

/** Downloads the image (a Vane upload or a public https link) with a hard size cap, since Bluesky takes at most 1 MB. */
async function fetchImage(url: string): Promise<ImageResult> {
  if (!isValidMediaUrl(url)) return { ok: false, error: 'The attached image link is invalid.', retryable: false };
  let res: Response;
  try {
    res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) });
  } catch {
    return { ok: false, error: 'Could not download the attached image.', retryable: true };
  }
  if (!res.ok) return { ok: false, error: `The attached image could not be downloaded (HTTP ${res.status}).`, retryable: res.status >= 500 || res.status === 429 };
  const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!IMAGE_TYPES.includes(contentType)) return { ok: false, error: 'Bluesky takes JPEG, PNG, WebP or GIF images.', retryable: false };
  const tooBig = { ok: false as const, error: 'The image is larger than Bluesky allows (1 MB). Use a smaller image.', retryable: false };
  if (Number(res.headers.get('content-length')) > BLUESKY_IMAGE_MAX_BYTES) return tooBig;

  const reader = res.body?.getReader();
  if (!reader) return { ok: false, error: 'Could not download the attached image.', retryable: true };
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > BLUESKY_IMAGE_MAX_BYTES) {
        await reader.cancel();
        return tooBig;
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, error: 'Could not download the attached image.', retryable: true };
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  return { ok: true, bytes: bytes.buffer, contentType };
}

// ───────────────────────── send ─────────────────────────
export type BlueskySend =
  | { ok: true; uri: string }
  | { ok: false; error: string; retryable: boolean; retryAfter?: number };

export async function sendBlueskyPost(session: BlueskySession, content: string, mediaUrl?: string): Promise<BlueskySend> {
  if (utf8Length(content) > BLUESKY_TEXT_MAX_BYTES) return { ok: false, error: 'The text is too long for Bluesky.', retryable: false };

  const record: Record<string, unknown> = { $type: 'app.bsky.feed.post', text: content, createdAt: new Date().toISOString() };
  const facets = buildFacets(content);
  if (facets.length) record.facets = facets;

  if (mediaUrl) {
    const img = await fetchImage(mediaUrl);
    if (!img.ok) return { ok: false, error: img.error, retryable: img.retryable };
    const up = await xrpc<{ blob: unknown }>('com.atproto.repo.uploadBlob', { jwt: session.jwt, bytes: img.bytes, contentType: img.contentType }, IMAGE_TIMEOUT_MS);
    if (!up.ok) return failure(up);
    record.embed = { $type: 'app.bsky.embed.images', images: [{ alt: '', image: up.data.blob }] };
  }

  const r = await xrpc<{ uri: string }>('com.atproto.repo.createRecord', { jwt: session.jwt, json: { repo: session.did, collection: 'app.bsky.feed.post', record } });
  if (!r.ok) return failure(r);
  return { ok: true, uri: r.data.uri };
}

function failure(e: BskyErr): { ok: false; error: string; retryable: boolean; retryAfter?: number } {
  if (e.network) return { ok: false, error: e.message, retryable: true };
  if (e.status === 429) return { ok: false, error: 'Bluesky is rate limiting this account.', retryable: true, retryAfter: e.retryAfter };
  if (e.status >= 500) return { ok: false, error: 'Bluesky had a temporary error.', retryable: true };
  if (e.status === 401 || e.status === 403) return { ok: false, error: 'Bluesky refused the saved app password. Reconnect the account.', retryable: false };
  return { ok: false, error: `Bluesky rejected the post: ${e.message}`, retryable: false };
}
