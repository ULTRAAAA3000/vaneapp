/**
 * Instagram Reels for Vane Studio (Instagram API with Instagram Login, host graph.instagram.com). Business and Creator accounts only.
 *
 *   instagramConfigured(env)                         INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET set?
 *   instagramAuthorizeUrl(env, redirectUri, state)   scopes: instagram_business_basic, instagram_business_content_publish
 *   instagramExchange(env, redirectUri, code, now)   code → short token → long-lived token (60 days) + username
 *   instagramPublisher                               plugged into REAL in ./videopublishers.ts
 *
 * Publishing a Reel: Instagram does not take an upload, it FETCHES the video from a public https address. Vane gives it a temporary
 * public link to the file in R2 (the video's own link if the owner made one, otherwise one that is removed right after), creates a
 * REELS container, waits until Instagram has processed it, then publishes it. Creating a container is harmless to repeat, only the
 * last call publishes, so a retry never doubles a Reel.
 * Instagram has no private or unlisted videos: a Reel is always public (the publish dialog says so and the server refuses anything else).
 * The long-lived token is stored encrypted and renewed here before it runs out. This file is NOT a route.
 */
import type { Env } from '../../../types';
import { decryptToken, encryptToken } from './crypto';
import { callJson, shortMessage, type CallErr } from './httpcall';
import { productUrl } from './hosts';
import type { PublishEnv, PublishJob, PublishOutcome, VideoPublisher } from './videopublishers';

export const INSTAGRAM_SCOPE = 'instagram_business_basic,instagram_business_content_publish';
export const REEL_MAX_BYTES = 300 * 1024 * 1024;
const CAPTION_MAX = 2200;
const GRAPH = 'https://graph.instagram.com/v21.0';
const RENEW_BEFORE = 20 * 24 * 3600;
const POLLS = 30;

type IgEnv = Pick<Env, 'INSTAGRAM_APP_ID' | 'INSTAGRAM_APP_SECRET'>;
const creds = (env: IgEnv): { id: string; secret: string } | null => (env.INSTAGRAM_APP_ID && env.INSTAGRAM_APP_SECRET ? { id: env.INSTAGRAM_APP_ID, secret: env.INSTAGRAM_APP_SECRET } : null);
export const instagramConfigured = (env: IgEnv): boolean => creds(env) !== null;

export const instagramAuthorizeUrl = (env: IgEnv, redirectUri: string, state: string): string =>
  'https://www.instagram.com/oauth/authorize?' + new URLSearchParams({ client_id: creds(env)!.id, redirect_uri: redirectUri, response_type: 'code', scope: INSTAGRAM_SCOPE, state }).toString();

export interface InstagramCreds { userId: string; username: string; accessToken: string; expiresAt: number }
export type IgExchanged = { ok: true; creds: InstagramCreds } | { ok: false; code: 'failed' | 'no_publish' };

export async function instagramExchange(env: IgEnv, redirectUri: string, code: string, now: number): Promise<IgExchanged> {
  const c = creds(env);
  if (!c) return { ok: false, code: 'failed' };
  const t = await callJson<{ access_token?: unknown; user_id?: unknown; permissions?: unknown }>('https://api.instagram.com/oauth/access_token', {
    method: 'POST', form: { client_id: c.id, client_secret: c.secret, grant_type: 'authorization_code', redirect_uri: redirectUri, code },
  });
  const td = t.ok ? t.data : null;
  const short = td?.access_token;
  if (typeof short !== 'string' || !short) return { ok: false, code: 'failed' };
  const perms = td?.permissions;
  const list = Array.isArray(perms) ? perms.map(String) : typeof perms === 'string' ? perms.split(/[,\s]+/) : null;
  if (list && !list.includes('instagram_business_content_publish')) return { ok: false, code: 'no_publish' };

  const l = await callJson<{ access_token?: unknown; expires_in?: unknown }>(`https://graph.instagram.com/access_token?${new URLSearchParams({ grant_type: 'ig_exchange_token', client_secret: c.secret, access_token: short }).toString()}`);
  const ld = l.ok ? l.data : null;
  const long = ld?.access_token;
  if (typeof long !== 'string' || !long) return { ok: false, code: 'failed' };
  const life = typeof ld?.expires_in === 'number' && ld.expires_in > 0 ? ld.expires_in : 60 * 24 * 3600;

  const me = await callJson<{ user_id?: unknown; id?: unknown; username?: unknown }>(`${GRAPH}/me?fields=user_id,username`, { headers: { Authorization: `Bearer ${long}` } });
  const uid = me.ok ? String(me.data?.user_id ?? me.data?.id ?? '') : '';
  const username = me.ok && typeof me.data?.username === 'string' ? me.data.username : '';
  if (!/^\d{3,30}$/.test(uid) || !/^[A-Za-z0-9_.]{1,40}$/.test(username)) return { ok: false, code: 'failed' };
  return { ok: true, creds: { userId: uid, username, accessToken: long, expiresAt: now + life } };
}

const blobOf = (c: InstagramCreds): string => JSON.stringify({ userId: c.userId, username: c.username, accessToken: c.accessToken, expiresAt: c.expiresAt });
export const instagramBlob = blobOf;

async function load(encrypted: string, key: string): Promise<InstagramCreds | null> {
  try {
    const p = JSON.parse(await decryptToken(encrypted, key));
    if (typeof p?.accessToken !== 'string' || !p.accessToken || typeof p?.userId !== 'string' || !/^\d{3,30}$/.test(p.userId)) return null;
    return { userId: p.userId, username: String(p.username ?? ''), accessToken: p.accessToken, expiresAt: typeof p.expiresAt === 'number' ? p.expiresAt : 0 };
  } catch {
    return null;
  }
}

// ───────────────────────── the publisher ─────────────────────────
const fail = (retryable: boolean, error: string): PublishOutcome => ({ ok: false, retryable, error });
const RATE = new Set([4, 17, 32, 613]);

function explain(e: CallErr): PublishOutcome {
  const err = (e.data as { error?: { code?: unknown; error_user_msg?: unknown } } | null)?.error;
  const code = typeof err?.code === 'number' ? err.code : 0;
  if (e.network || e.status >= 500 || code === 1 || code === 2) return fail(true, 'Instagram did not answer. It will be tried again.');
  if (e.status === 429 || RATE.has(code)) return fail(true, 'Instagram is rate limiting this account. It will be tried again.');
  if (code === 190 || e.status === 401) return fail(false, 'Instagram no longer accepts the connection. Disconnect the account and connect it again.');
  const human = typeof err?.error_user_msg === 'string' && err.error_user_msg ? err.error_user_msg.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200) : shortMessage(e.data, `error ${e.status}`);
  return fail(false, `Instagram refused the Reel: ${human}`);
}

/** The video's public address for the moment Instagram fetches it. A link the owner already made is reused and kept; otherwise one is made and removed afterwards. */
async function withPublicLink<T>(env: PublishEnv, videoId: string, run: (token: string) => Promise<T>): Promise<T> {
  const have = await env.DB.prepare('SELECT token FROM video_links WHERE video_id = ?1').bind(videoId).first<{ token: string }>();
  if (have) return run(have.token);
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  await env.DB.prepare('INSERT OR IGNORE INTO video_links (token, video_id) VALUES (?1, ?2)').bind(token, videoId).run();
  const mine = await env.DB.prepare('SELECT token FROM video_links WHERE video_id = ?1').bind(videoId).first<{ token: string }>();
  try {
    return await run(mine?.token ?? token);
  } finally {
    if (mine?.token === token) await env.DB.prepare('DELETE FROM video_links WHERE token = ?1').bind(token).run().catch(() => undefined);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function makePublisher(pollMs = 4000): VideoPublisher {
  return {
    async publish(env: PublishEnv, job: PublishJob): Promise<PublishOutcome> {
      if (!env.ENCRYPTION_KEY) return fail(false, 'Server encryption is not set up.');
      if (job.privacy !== 'public') return fail(false, 'Instagram has no private or unlisted videos. Publish it as Public.');
      if (job.video.sizeBytes > REEL_MAX_BYTES) return fail(false, 'Instagram accepts Reels up to 300 MB. This video is larger.');
      let c = await load(job.channel.credentials, env.ENCRYPTION_KEY);
      if (!c) return fail(false, 'The saved Instagram connection is damaged. Disconnect the account and connect it again.');
      const now = Math.floor(Date.now() / 1000);
      if (c.expiresAt && c.expiresAt <= now) return fail(false, 'The Instagram connection has expired. Disconnect the account and connect it again.');

      // Renew the 60-day token while it is still valid (Instagram allows it once the token is a day old; failing is harmless).
      if (c.expiresAt && c.expiresAt - now < RENEW_BEFORE) {
        const r = await callJson<{ access_token?: unknown; expires_in?: unknown }>(`https://graph.instagram.com/refresh_access_token?${new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: c.accessToken }).toString()}`);
        if (r.ok && typeof r.data?.access_token === 'string' && r.data.access_token) {
          c = { ...c, accessToken: r.data.access_token, expiresAt: now + (typeof r.data.expires_in === 'number' && r.data.expires_in > 0 ? r.data.expires_in : 60 * 24 * 3600) };
          await env.DB.prepare('UPDATE video_channels SET credentials = ?2, updated_at = unixepoch() WHERE id = ?1').bind(job.channel.id, await encryptToken(blobOf(c), env.ENCRYPTION_KEY)).run().catch(() => undefined);
        }
      }
      const auth = { Authorization: `Bearer ${c.accessToken}` };
      const caption = (job.description.trim() || job.title.trim()).slice(0, CAPTION_MAX);

      return withPublicLink(env, job.video.id, async (token) => {
        const base = productUrl('studio', `/api/video/public/${token}`);
        const form: Record<string, string> = { media_type: 'REELS', video_url: base, caption, share_to_feed: job.options?.instagram?.shareToFeed === false ? 'false' : 'true' };
        if (job.video.cover?.contentType === 'image/jpeg') form.cover_url = `${base}/cover`;
        const made = await callJson<{ id?: unknown }>(`${GRAPH}/${c!.userId}/media`, { method: 'POST', headers: auth, form, timeoutMs: 30_000 });
        if (!made.ok) return explain(made);
        const container = made.data?.id;
        if (typeof container !== 'string' || !/^\d{3,40}$/.test(container)) return fail(true, 'Instagram did not accept the video. It will be tried again.');

        let ready = false;
        for (let i = 0; i < POLLS && !ready; i++) {
          const s = await callJson<{ status_code?: unknown; status?: unknown }>(`${GRAPH}/${container}?fields=status_code,status`, { headers: auth });
          if (s.ok) {
            const code = String(s.data?.status_code ?? '');
            if (code === 'FINISHED') ready = true;
            else if (code === 'ERROR' || code === 'EXPIRED') {
              return fail(false, `Instagram could not process the video${typeof s.data?.status === 'string' ? `: ${shortMessage({ message: s.data.status }, '')}` : '.'} Reels need MP4 or MOV (H.264 video, AAC audio), vertical 9:16 works best, 3 seconds to 15 minutes.`);
            }
          } else if (s.status >= 400 && s.status < 500 && s.status !== 429) return explain(s);
          if (!ready && i < POLLS - 1) await sleep(pollMs);
        }
        if (!ready) return fail(true, 'Instagram is still processing the video. It will be tried again.');

        const pub = await callJson<{ id?: unknown }>(`${GRAPH}/${c!.userId}/media_publish`, { method: 'POST', headers: auth, form: { creation_id: container }, timeoutMs: 30_000 });
        if (!pub.ok) return explain(pub);
        const id = typeof pub.data?.id === 'string' ? pub.data.id : '';
        if (!id) return fail(true, 'Instagram did not confirm the Reel.');
        const link = await callJson<{ permalink?: unknown }>(`${GRAPH}/${id}?fields=permalink`, { headers: auth });
        const url = link.ok && typeof link.data?.permalink === 'string' && link.data.permalink.startsWith('https://') ? link.data.permalink : null;
        return { ok: true, externalId: id, url };
      });
    },
  };
}

export const instagramPublisher: VideoPublisher = makePublisher();
