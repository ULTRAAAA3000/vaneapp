/**
 * Facebook Pages (Meta Graph API). One Vane channel = one Facebook Page the person manages. Connecting asks Facebook which Pages the
 * person may post to and saves each as a channel (with that Page's own access token, which does not expire when it comes from a
 * long-lived user token). Personal profiles cannot be posted to by apps, only Pages.
 *
 *   facebookConfigured(env)                  FACEBOOK_APP_ID / FACEBOOK_APP_SECRET set?
 *   authorizeUrl(env, redirectUri, state)    scopes: pages_show_list, pages_manage_posts, pages_read_engagement
 *   exchangeCode(env, redirectUri, code)     code → short token → long-lived user token → the person's Pages with their tokens
 *   sendFacebookPost(creds, content, media)  /{page}/feed (text), /{page}/photos (image) or /{page}/videos (video)
 *
 * Tokens are stored encrypted and never logged. Meta fetches pictures and videos from their public https address itself.
 * This file is NOT a route.
 */
import { decryptToken } from '../lib/crypto';
import { callJson, shortMessage, type CallErr } from '../lib/httpcall';
import { mediaKindFromUrl } from '../lib/media';

export const FACEBOOK_TEXT_LIMIT = 5000;
const VERSION = 'v21.0';
const GRAPH = `https://graph.facebook.com/${VERSION}`;

export interface FacebookEnv { FACEBOOK_APP_ID?: string; FACEBOOK_APP_SECRET?: string }
export const facebookConfigured = (env: FacebookEnv): boolean => Boolean(env.FACEBOOK_APP_ID && env.FACEBOOK_APP_SECRET);

export function authorizeUrl(env: FacebookEnv, redirectUri: string, state: string): string {
  return `https://www.facebook.com/${VERSION}/dialog/oauth?${new URLSearchParams({
    client_id: env.FACEBOOK_APP_ID ?? '', redirect_uri: redirectUri, state, response_type: 'code', scope: 'pages_show_list,pages_manage_posts,pages_read_engagement',
  }).toString()}`;
}

export interface FacebookPage { pageId: string; name: string; accessToken: string }
export type ConnectResult = { ok: true; pages: FacebookPage[] } | { ok: false; reason: 'failed' | 'noperm' | 'nopages' };

export async function exchangeCode(env: FacebookEnv, redirectUri: string, code: string): Promise<ConnectResult> {
  const short = await callJson<{ access_token?: unknown }>(`${GRAPH}/oauth/access_token?${new URLSearchParams({ client_id: env.FACEBOOK_APP_ID ?? '', client_secret: env.FACEBOOK_APP_SECRET ?? '', redirect_uri: redirectUri, code }).toString()}`);
  const t = short.ok ? short.data?.access_token : undefined;
  if (typeof t !== 'string' || !t) return { ok: false, reason: 'failed' };
  const long = await callJson<{ access_token?: unknown }>(`${GRAPH}/oauth/access_token?${new URLSearchParams({ grant_type: 'fb_exchange_token', client_id: env.FACEBOOK_APP_ID ?? '', client_secret: env.FACEBOOK_APP_SECRET ?? '', fb_exchange_token: t }).toString()}`);
  const lt = long.ok ? long.data?.access_token : undefined;
  if (typeof lt !== 'string' || !lt) return { ok: false, reason: 'failed' };

  const perms = await callJson<{ data?: { permission?: string; status?: string }[] }>(`${GRAPH}/me/permissions`, { headers: { Authorization: `Bearer ${lt}` } });
  if (perms.ok && Array.isArray(perms.data?.data) && !perms.data.data.some((p) => p.permission === 'pages_manage_posts' && p.status === 'granted')) return { ok: false, reason: 'noperm' };

  const acc = await callJson<{ data?: { id?: unknown; name?: unknown; access_token?: unknown }[] }>(`${GRAPH}/me/accounts?fields=id,name,access_token&limit=25`, { headers: { Authorization: `Bearer ${lt}` } });
  if (!acc.ok) return { ok: false, reason: 'failed' };
  const pages: FacebookPage[] = [];
  for (const p of acc.data?.data ?? []) {
    if (typeof p.id === 'string' && /^\d{5,30}$/.test(p.id) && typeof p.access_token === 'string' && p.access_token) {
      pages.push({ pageId: p.id, name: typeof p.name === 'string' ? p.name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80) || 'Facebook Page' : 'Facebook Page', accessToken: p.access_token });
    }
  }
  return pages.length ? { ok: true, pages } : { ok: false, reason: 'nopages' };
}

// ───────────────────────── credentials ─────────────────────────
export interface FacebookCreds { pageId: string; pageName: string; accessToken: string }
export const facebookBlob = (c: FacebookCreds): Record<string, unknown> => ({ type: 'facebook', pageId: c.pageId, pageName: c.pageName, accessToken: c.accessToken });

export async function loadFacebookCreds(encrypted: string, key: string | undefined): Promise<FacebookCreds | null> {
  if (!key) return null;
  try {
    const p = JSON.parse(await decryptToken(encrypted, key));
    if (typeof p?.accessToken !== 'string' || !p.accessToken || typeof p?.pageId !== 'string' || !/^\d{5,30}$/.test(p.pageId)) return null;
    return { pageId: p.pageId, pageName: String(p.pageName ?? ''), accessToken: p.accessToken };
  } catch {
    return null;
  }
}
export async function facebookIdentity(encrypted: string, key: string | undefined): Promise<string | null> {
  return (await loadFacebookCreds(encrypted, key))?.pageId ?? null;
}

// ───────────────────────── publishing ─────────────────────────
export type FacebookSend = { ok: true; id: string; url: string } | { ok: false; error: string; retryable: boolean; retryAfter?: number };
const fail = (error: string, retryable: boolean, retryAfter?: number): Extract<FacebookSend, { ok: false }> => ({ ok: false, error, retryable, retryAfter });
const RATE = new Set([4, 17, 32, 613]);

function failure(e: CallErr): Extract<FacebookSend, { ok: false }> {
  const err = (e.data as { error?: { code?: unknown } } | null)?.error;
  const code = typeof err?.code === 'number' ? err.code : 0;
  if (e.network) return fail('Facebook did not answer in time.', true);
  if (e.status === 429 || RATE.has(code)) return fail('Facebook is rate limiting this Page.', true, e.retryAfter);
  if (e.status >= 500 || code === 1 || code === 2) return fail('Facebook had a temporary error.', true);
  if (code === 190 || e.status === 401) return fail('Facebook no longer accepts the saved sign-in. Reconnect the Page.', false);
  if (code === 200 || code === 10 || code === 220 || e.status === 403) return fail('Facebook did not allow this post. Reconnect the Page and allow Vane to publish.', false);
  if (code === 506) return fail('Facebook refused a duplicate post. Change the text a little.', false);
  return fail(`Facebook rejected the post: ${shortMessage(e.data, `HTTP ${e.status}`)}`, false);
}

export async function sendFacebookPost(creds: FacebookCreds, content: string, mediaUrl: string | undefined): Promise<FacebookSend> {
  const auth = { Authorization: `Bearer ${creds.accessToken}` };
  let path = 'feed';
  const form: Record<string, string> = { message: content };
  if (mediaUrl) {
    const video = mediaKindFromUrl(mediaUrl) === 'video';
    path = video ? 'videos' : 'photos';
    delete form.message;
    form[video ? 'file_url' : 'url'] = mediaUrl;
    form[video ? 'description' : 'caption'] = content;
  }
  const r = await callJson<{ id?: unknown; post_id?: unknown }>(`${GRAPH}/${creds.pageId}/${path}`, { method: 'POST', headers: auth, form, timeoutMs: path === 'videos' ? 60_000 : 20_000 });
  if (!r.ok) return failure(r);
  const id = typeof r.data?.post_id === 'string' ? r.data.post_id : typeof r.data?.id === 'string' ? r.data.id : '';
  if (!id) return fail('Facebook did not confirm the post.', true);
  return { ok: true, id, url: `https://www.facebook.com/${encodeURIComponent(id)}` };
}
