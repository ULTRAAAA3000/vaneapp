import { decryptToken } from '../lib/crypto';
import { callJson, shortMessage } from '../lib/httpcall';
import { mediaKindFromUrl } from '../lib/media';

export const PINTEREST_TITLE_LIMIT = 100;
export const PINTEREST_DESCRIPTION_LIMIT = 800;
export const PINTEREST_RENEW_BEFORE_SECONDS = 3 * 24 * 3600;
const AUTH = 'https://www.pinterest.com/oauth/';
const API = 'https://api.pinterest.com/v5';

export interface PinterestEnv { PINTEREST_APP_ID?: string; PINTEREST_APP_SECRET?: string }
export const pinterestConfigured = (env: PinterestEnv): boolean => Boolean(env.PINTEREST_APP_ID && env.PINTEREST_APP_SECRET);
const basic = (env: PinterestEnv): string => `Basic ${btoa(`${env.PINTEREST_APP_ID ?? ''}:${env.PINTEREST_APP_SECRET ?? ''}`)}`;

export function cleanBoard(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return s.length >= 1 && s.length <= 100 ? s : null;
}

export function splitPin(content: string): { title: string; description: string; link: string | null } {
  const lines = content.replace(/\r\n/g, '\n').trim().split('\n');
  const title = (lines[0] ?? '').replace(/^#+\s*/, '').trim();
  const description = lines.slice(1).join('\n').trim();
  const found = /https:\/\/[^\s<>"')]+/.exec(content);
  return { title, description, link: found ? found[0].slice(0, 2000) : null };
}

export function authorizeUrl(env: PinterestEnv, redirectUri: string, state: string): string {
  return `${AUTH}?${new URLSearchParams({ client_id: env.PINTEREST_APP_ID ?? '', redirect_uri: redirectUri, response_type: 'code', scope: 'boards:read,pins:read,pins:write,user_accounts:read', state }).toString()}`;
}

export interface PinterestTokens { accessToken: string; refreshToken: string; expiresAt: number }
export type ConnectResult = { ok: true; tokens: PinterestTokens } | { ok: false; reason: 'failed' | 'noperm' };

interface TokenAnswer { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; scope?: unknown; code?: unknown }

function readTokens(d: TokenAnswer | null, now: number, keep: string): PinterestTokens | null {
  const a = d?.access_token;
  if (typeof a !== 'string' || !a) return null;
  const rt = typeof d?.refresh_token === 'string' && d.refresh_token ? d.refresh_token : keep;
  if (!rt) return null;
  const life = typeof d?.expires_in === 'number' && d.expires_in > 0 ? d.expires_in : 2592000;
  return { accessToken: a, refreshToken: rt, expiresAt: now + life };
}

export async function exchangeCode(env: PinterestEnv, redirectUri: string, code: string, now: number): Promise<ConnectResult> {
  const r = await callJson<TokenAnswer>(`${API}/oauth/token`, {
    method: 'POST', headers: { Authorization: basic(env) }, form: { grant_type: 'authorization_code', code, redirect_uri: redirectUri },
  });
  if (!r.ok) return { ok: false, reason: 'failed' };
  const scope = r.data?.scope;
  if (typeof scope === 'string' && !scope.split(/[ ,]/).includes('pins:write')) return { ok: false, reason: 'noperm' };
  const tokens = readTokens(r.data, now, '');
  return tokens ? { ok: true, tokens } : { ok: false, reason: 'failed' };
}

export type ProfileResult = { ok: true; username: string } | { ok: false };
export async function readProfile(accessToken: string): Promise<ProfileResult> {
  const r = await callJson<{ username?: unknown }>(`${API}/user_account`, { headers: { Authorization: `Bearer ${accessToken}` } });
  const name = r.ok ? r.data?.username : undefined;
  return typeof name === 'string' && /^[A-Za-z0-9_.-]{1,60}$/.test(name) ? { ok: true, username: name } : { ok: false };
}

export type BoardResult = { ok: true; id: string; name: string } | { ok: false; reason: 'noboard' | 'failed' };
export async function findBoard(accessToken: string, wanted: string): Promise<BoardResult> {
  const want = wanted.trim().toLowerCase();
  let bookmark = '';
  for (let page = 0; page < 5; page++) {
    const q = new URLSearchParams({ page_size: '100' });
    if (bookmark) q.set('bookmark', bookmark);
    const r = await callJson<{ items?: { id?: unknown; name?: unknown }[]; bookmark?: unknown }>(`${API}/boards?${q.toString()}`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!r.ok) return { ok: false, reason: 'failed' };
    for (const b of r.data?.items ?? []) {
      if (typeof b.id === 'string' && /^\d{1,30}$/.test(b.id) && typeof b.name === 'string' && b.name.trim().toLowerCase() === want) return { ok: true, id: b.id, name: b.name };
    }
    bookmark = typeof r.data?.bookmark === 'string' ? r.data.bookmark : '';
    if (!bookmark) break;
  }
  return { ok: false, reason: 'noboard' };
}

export interface PinterestCreds { username: string; boardId: string; boardName: string; accessToken: string; refreshToken: string; expiresAt: number }

export const pinterestBlob = (c: PinterestCreds): Record<string, unknown> => ({ type: 'pinterest', username: c.username, boardId: c.boardId, boardName: c.boardName, accessToken: c.accessToken, refreshToken: c.refreshToken, expiresAt: c.expiresAt });
export const pinterestIdentityOf = (username: string, boardId: string): string => `${username.toLowerCase()}|${boardId}`;

export async function loadPinterestCreds(encrypted: string, key: string | undefined): Promise<PinterestCreds | null> {
  if (!key) return null;
  try {
    const p = JSON.parse(await decryptToken(encrypted, key));
    if (typeof p?.refreshToken !== 'string' || !p.refreshToken || typeof p?.boardId !== 'string' || !/^\d{1,30}$/.test(p.boardId)) return null;
    return { username: String(p.username ?? ''), boardId: p.boardId, boardName: String(p.boardName ?? ''), accessToken: String(p.accessToken ?? ''), refreshToken: p.refreshToken, expiresAt: typeof p.expiresAt === 'number' ? p.expiresAt : 0 };
  } catch {
    return null;
  }
}

export async function pinterestIdentity(encrypted: string, key: string | undefined): Promise<string | null> {
  const c = await loadPinterestCreds(encrypted, key);
  return c ? pinterestIdentityOf(c.username, c.boardId) : null;
}

export async function refreshPinterestToken(env: PinterestEnv, creds: PinterestCreds, now: number): Promise<{ ok: true; creds: PinterestCreds } | { ok: false; revoked: boolean }> {
  const r = await callJson<TokenAnswer>(`${API}/oauth/token`, {
    method: 'POST', headers: { Authorization: basic(env) }, form: { grant_type: 'refresh_token', refresh_token: creds.refreshToken },
  });
  if (!r.ok) return { ok: false, revoked: r.status === 400 || r.status === 401 || r.status === 403 };
  const t = readTokens(r.data, now, creds.refreshToken);
  return t ? { ok: true, creds: { ...creds, ...t } } : { ok: false, revoked: false };
}

export type PinterestSend = { ok: true; id: string; url: string } | { ok: false; error: string; retryable: boolean; retryAfter?: number };
const fail = (error: string, retryable: boolean, retryAfter?: number): Extract<PinterestSend, { ok: false }> => ({ ok: false, error, retryable, retryAfter });

export async function sendPinterestPin(creds: PinterestCreds, content: string, mediaUrl: string | undefined): Promise<PinterestSend> {
  if (!mediaUrl) return fail('A Pinterest pin needs a picture. Attach an image.', false);
  if (mediaKindFromUrl(mediaUrl) === 'video') return fail('Pinterest pins with video are not supported yet. Attach an image.', false);
  const { title, description, link } = splitPin(content);
  if (!title) return fail('A Pinterest pin needs a title: put it on the first line.', false);
  if (title.length > PINTEREST_TITLE_LIMIT) return fail(`The first line is the pin title and can be at most ${PINTEREST_TITLE_LIMIT} characters (it has ${title.length}).`, false);

  const body: Record<string, unknown> = {
    board_id: creds.boardId,
    title,
    description: description.slice(0, PINTEREST_DESCRIPTION_LIMIT),
    media_source: { source_type: 'image_url', url: mediaUrl },
  };
  if (link) body.link = link;

  const r = await callJson<{ id?: unknown }>(`${API}/pins`, { method: 'POST', headers: { Authorization: `Bearer ${creds.accessToken}` }, json: body, timeoutMs: 30_000 });
  if (!r.ok) {
    if (r.network || r.status >= 500) return fail('Pinterest did not answer in time.', true);
    if (r.status === 429) return fail('Pinterest is rate limiting this account.', true, r.retryAfter);
    if (r.status === 401) return fail('Pinterest no longer accepts the saved sign-in. Reconnect the account.', false);
    if (r.status === 403) return fail('Pinterest did not allow this pin. Reconnect the account and allow Vane to publish.', false);
    if (r.status === 404) return fail(`The board "${creds.boardName}" no longer exists. Connect the account again with another board.`, false);
    return fail(`Pinterest rejected the pin: ${shortMessage(r.data, `HTTP ${r.status}`)}`, false);
  }
  const id = typeof r.data?.id === 'string' && /^\d{1,30}$/.test(r.data.id) ? r.data.id : '';
  if (!id) return fail('Pinterest did not confirm the pin.', true);
  return { ok: true, id, url: `https://www.pinterest.com/pin/${id}/` };
}
