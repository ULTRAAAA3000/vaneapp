/**
 * YouTube for Vane Studio: the Google sign-in that connects a channel, and the publisher that uploads a video to it.
 *
 *   youtubeConfigured(env)                       both YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET are set
 *   youtubeAuthorizeUrl(env, redirectUri, state, challenge)
 *   youtubeExchange(env, redirectUri, code, verifier)   code → { refreshToken, subject, label }
 *   youtubePublisher                                    plugged into REAL in ./videopublishers.ts
 *
 * Only ONE sensitive scope is asked: `youtube.upload` (plus openid/email/profile to name the account in the dashboard). Vane cannot
 * read the person's videos, playlists or analytics, and says so on the consent screen of Google.
 * The refresh token is stored encrypted (AES-GCM, like every network credential); access tokens are never stored.
 *
 * Until Google has approved Vane (brand + sensitive-scope verification and the API audit) YouTube keeps every upload PRIVATE and the
 * consent screen "Testing" lets a refresh token live 7 days. The publisher therefore tells the person the truth after each upload.
 * This file is NOT a route.
 */
import type { Env } from '../../../types';
import { decryptToken } from './crypto';
import { callJson, shortMessage } from './httpcall';
import type { PublishEnv, PublishJob, PublishOutcome, VideoPublisher } from './videopublishers';

export const YOUTUBE_SCOPE = 'https://www.googleapis.com/auth/youtube.upload';
const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';
const UPLOAD = 'https://www.googleapis.com/upload/youtube/v3/videos';
const THUMB = 'https://www.googleapis.com/upload/youtube/v3/thumbnails/set';
/** A multiple of 256 KiB, as the resumable protocol requires. */
export const CHUNK = 8 * 1024 * 1024;
const THUMB_MAX = 2 * 1024 * 1024;

/** The categories offered in the publish dialog (YouTube category ids). */
export const YT_CATEGORIES: Record<string, string> = {
  '22': 'People & Blogs', '1': 'Film & Animation', '2': 'Autos & Vehicles', '10': 'Music', '15': 'Pets & Animals', '17': 'Sports', '19': 'Travel & Events',
  '20': 'Gaming', '23': 'Comedy', '24': 'Entertainment', '25': 'News & Politics', '26': 'Howto & Style', '27': 'Education', '28': 'Science & Technology', '29': 'Nonprofits & Activism',
};

export interface YoutubeOptions { madeForKids: boolean; category: string }

type YtEnv = Pick<Env, 'YOUTUBE_CLIENT_ID' | 'YOUTUBE_CLIENT_SECRET'>;
const creds = (env: YtEnv): { id: string; secret: string } | null => (env.YOUTUBE_CLIENT_ID && env.YOUTUBE_CLIENT_SECRET ? { id: env.YOUTUBE_CLIENT_ID, secret: env.YOUTUBE_CLIENT_SECRET } : null);
export const youtubeConfigured = (env: YtEnv): boolean => creds(env) !== null;

export function youtubeAuthorizeUrl(env: YtEnv, redirectUri: string, state: string, challenge: string): string {
  const c = creds(env)!;
  return AUTH + '?' + new URLSearchParams({
    client_id: c.id, redirect_uri: redirectUri, response_type: 'code', scope: `openid email profile ${YOUTUBE_SCOPE}`, state,
    code_challenge: challenge, code_challenge_method: 'S256',
    access_type: 'offline', prompt: 'consent select_account', include_granted_scopes: 'false',
  });
}

const clean = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '');

export type Exchanged = { ok: true; refreshToken: string; subject: string; label: string } | { ok: false; code: 'failed' | 'no_upload' | 'no_refresh' };

export async function youtubeExchange(env: YtEnv, redirectUri: string, code: string, verifier: string): Promise<Exchanged> {
  const c = creds(env);
  if (!c) return { ok: false, code: 'failed' };
  const t = await callJson<{ access_token?: string; refresh_token?: string; scope?: string }>(TOKEN, {
    method: 'POST', form: { client_id: c.id, client_secret: c.secret, code, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verifier },
  });
  if (!t.ok || !t.data?.access_token) return { ok: false, code: 'failed' };
  // The person can untick the upload permission on Google's screen: then there is nothing to publish with.
  if (!(t.data.scope ?? '').split(' ').includes(YOUTUBE_SCOPE)) return { ok: false, code: 'no_upload' };
  if (!t.data.refresh_token) return { ok: false, code: 'no_refresh' };
  const u = await callJson<{ sub?: string; email?: string; name?: string }>(USERINFO, { headers: { Authorization: `Bearer ${t.data.access_token}` } });
  if (!u.ok || !u.data?.sub) return { ok: false, code: 'failed' };
  const name = clean(u.data.name, 60), email = clean(u.data.email, 80);
  return { ok: true, refreshToken: t.data.refresh_token, subject: clean(u.data.sub, 64), label: (name && email ? `${name} (${email})` : name || email || 'YouTube').slice(0, 120) };
}

// ───────────────────────── the publisher ─────────────────────────

const fail = (retryable: boolean, error: string): PublishOutcome => ({ ok: false, retryable, error });

/** Maps a Google API answer that was not a success to what the person should read, and whether trying again can help. */
function explain(status: number, data: unknown, retryAfter?: number): PublishOutcome {
  if (status === 0 || status >= 500 || status === 408) return fail(true, 'YouTube did not answer. It will be tried again.');
  const reason = ((data as { error?: { errors?: { reason?: string }[] } } | null)?.error?.errors?.[0]?.reason ?? '').toString();
  if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') return fail(false, 'The daily YouTube upload quota of Vane is used up. Try again tomorrow.');
  if (reason === 'uploadLimitExceeded') return fail(false, 'This YouTube channel has reached its daily upload limit. Try again later.');
  if (reason === 'rateLimitExceeded' || status === 429) return fail(retryAfter === undefined || retryAfter < 600, 'YouTube asks to slow down. It will be tried again.');
  if (reason === 'youtubeSignupRequired') return fail(false, 'This Google account has no YouTube channel. Create one on youtube.com and connect again.');
  if (status === 401) return fail(false, 'YouTube no longer accepts the connection. Disconnect the channel and connect it again.');
  return fail(false, 'YouTube refused the video: ' + shortMessage(data, `error ${status}`));
}

async function accessToken(env: PublishEnv, credentials: string): Promise<{ ok: true; token: string } | { ok: false; outcome: PublishOutcome }> {
  const c = creds(env);
  if (!c) return { ok: false, outcome: fail(false, 'YouTube is not set up on this server.') };
  if (!env.ENCRYPTION_KEY) return { ok: false, outcome: fail(false, 'Server encryption is not set up.') };
  let refresh = '';
  try {
    const v: unknown = JSON.parse(await decryptToken(credentials, env.ENCRYPTION_KEY));
    refresh = typeof v === 'object' && v !== null && typeof (v as { refreshToken?: unknown }).refreshToken === 'string' ? (v as { refreshToken: string }).refreshToken : '';
  } catch { /* handled below */ }
  if (!refresh) return { ok: false, outcome: fail(false, 'The saved YouTube connection is damaged. Disconnect the channel and connect it again.') };
  const r = await callJson<{ access_token?: string }>(TOKEN, { method: 'POST', form: { client_id: c.id, client_secret: c.secret, refresh_token: refresh, grant_type: 'refresh_token' } });
  if (r.ok && r.data?.access_token) return { ok: true, token: r.data.access_token };
  if (!r.ok && r.status >= 400 && r.status < 500) {
    // invalid_grant: revoked, or the 7-day token of an app that is still in Google's "Testing" mode ran out.
    return { ok: false, outcome: fail(false, 'Google no longer accepts this connection (access was revoked or expired). Disconnect the channel and connect it again.') };
  }
  return { ok: false, outcome: fail(true, 'Google did not answer. It will be tried again.') };
}

const noAngle = (s: string): string => s.replace(/[<>]/g, '');

function snippet(job: PublishJob, o: YoutubeOptions) {
  let used = 0;
  const tags: string[] = [];
  for (const t of job.video.tags) {
    const x = noAngle(t).trim();
    if (!x || x.length > 100 || used + x.length + 3 > 480) continue;
    used += x.length + 3;
    tags.push(x);
  }
  return {
    snippet: { title: noAngle(job.title).slice(0, 100) || 'Untitled', description: noAngle(job.description).slice(0, 5000), tags, categoryId: YT_CATEGORIES[o.category] ? o.category : '22' },
    status: { privacyStatus: job.privacy, selfDeclaredMadeForKids: o.madeForKids, embeddable: true },
  };
}

export const youtubePublisher: VideoPublisher = {
  async publish(env, job) {
    if (!env.MEDIA) return fail(false, 'Video storage is not available.');
    const opts: YoutubeOptions = job.options?.youtube ?? { madeForKids: false, category: '22' };
    const auth = await accessToken(env, job.channel.credentials);
    if (!auth.ok) return auth.outcome;
    const bearer = { Authorization: `Bearer ${auth.token}` };
    const size = job.video.sizeBytes;
    if (!(size > 0)) return fail(false, 'The video file is empty.');

    // 1. start a resumable upload
    const start = await callJson(`${UPLOAD}?uploadType=resumable&part=snippet,status`, {
      method: 'POST', headers: { ...bearer, 'X-Upload-Content-Length': String(size), 'X-Upload-Content-Type': job.video.contentType }, json: snippet(job, opts),
    });
    if (!start.ok) return explain(start.status, start.data, start.retryAfter);
    const session = start.headers.get('location') ?? '';
    let sessionUrl: URL;
    try { sessionUrl = new URL(session); } catch { return fail(true, 'YouTube gave no upload address. It will be tried again.'); }
    if (sessionUrl.protocol !== 'https:' || sessionUrl.hostname !== 'www.googleapis.com') return fail(true, 'YouTube gave an unexpected upload address. It will be tried again.');

    // 2. send the file in chunks, read straight from R2 (never the whole file in memory)
    let offset = 0;
    let videoId = '';
    let sentPrivacy: string | undefined;
    for (let guard = 0; guard < 4000 && !videoId; guard++) {
      const length = Math.min(CHUNK, size - offset);
      const obj = await env.MEDIA.get(job.video.r2Key, { range: { offset, length } });
      if (!obj) return fail(false, 'The video file could not be read from storage.');
      const bytes = await obj.arrayBuffer();
      if (bytes.byteLength !== length) return fail(false, 'The video file in storage does not match its size.');
      const res = await callJson<{ id?: string; status?: { privacyStatus?: string } }>(sessionUrl.toString(), {
        method: 'PUT', body: bytes, timeoutMs: 120_000,
        headers: { 'Content-Length': String(length), 'Content-Range': `bytes ${offset}-${offset + length - 1}/${size}`, 'Content-Type': job.video.contentType },
      });
      if (res.ok) {
        if (!res.data?.id) return fail(true, 'YouTube did not confirm the upload. It will be tried again.');
        videoId = res.data.id;
        sentPrivacy = res.data.status?.privacyStatus;
      } else if (res.status === 308) {
        const m = /bytes=0-(\d+)/.exec(res.headers?.get('range') ?? '');
        const next = m ? Number(m[1]) + 1 : offset;   // no Range header: the chunk was not kept, send it again
        if (next <= offset && guard > 3) return fail(true, 'The upload to YouTube stalled. It will be tried again.');
        offset = Math.min(next, size);
      } else return explain(res.status, res.data, res.retryAfter);
    }
    if (!videoId) return fail(true, 'The upload to YouTube did not finish. It will be tried again.');

    // 3. the cover (best effort: a failure here never undoes a published video)
    const notes: string[] = [];
    if (job.video.cover) {
      const cover = await env.MEDIA.get(job.video.cover.r2Key);
      if (cover && cover.size <= THUMB_MAX) {
        const t = await callJson(`${THUMB}?videoId=${encodeURIComponent(videoId)}&uploadType=media`, { method: 'POST', body: await cover.arrayBuffer(), headers: { ...bearer, 'Content-Type': job.video.cover.contentType } });
        if (!t.ok) notes.push('The cover was not accepted (YouTube allows custom covers only on verified channels).');
      } else if (cover) notes.push('The cover is larger than 2 MB, so YouTube was not sent it.');
    }
    if (sentPrivacy && sentPrivacy !== job.privacy) notes.push(`YouTube kept the video ${sentPrivacy} (Google has not approved Vane's API access yet).`);
    else if (!sentPrivacy && job.privacy !== 'private') notes.push('Until Google approves Vane, YouTube may keep new videos private.');
    return { ok: true, externalId: videoId, url: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`, note: notes.join(' ') || undefined };
  },
};
