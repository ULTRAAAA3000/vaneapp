/**
 * TikTok for Vane Studio (Login Kit + Content Posting API, Direct Post by URL). This file is NOT a route.
 *
 *   tiktokConfigured(env)                         TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET set?
 *   tiktokAuthorizeUrl(env, redirectUri, state)   scopes: user.info.basic, video.publish
 *   tiktokExchange(env, redirectUri, code, now)   code → access token (24 h) + refresh token (1 year) + the account's name
 *   tiktokCreatorInfo(env, channel)               what TikTok allows THIS account to do right now (who can see it, comments, Duet, Stitch)
 *   tiktokPublisher                               plugged into REAL in ./videopublishers.ts
 *
 * TikTok fetches the video from a public https address, so the same temporary link as for Instagram is used. Unlike Instagram,
 * starting a post is NOT harmless to repeat (it would post twice), so once TikTok has accepted the video this publisher never
 * starts a second one: if TikTok is still processing after a while, the publication is reported as published with a note.
 * Until TikTok audits Vane, it only accepts posts that are "Only me": the publish dialog says so and TikTok's answer is shown.
 */
import type { Env } from '../../../types';
import { decryptToken, encryptToken } from './crypto';
import { callJson, shortMessage, type CallErr } from './httpcall';
import { productUrl } from './hosts';
import type { PublishEnv, PublishJob, PublishOutcome, VideoPublisher } from './videopublishers';

export const TIKTOK_SCOPE = 'user.info.basic,video.publish';
export const TIKTOK_PRIVACY = ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'] as const;
export type TiktokPrivacy = (typeof TIKTOK_PRIVACY)[number];
export const isTiktokPrivacy = (v: unknown): v is TiktokPrivacy => typeof v === 'string' && (TIKTOK_PRIVACY as readonly string[]).includes(v);

export interface TiktokOptions { privacy: TiktokPrivacy; disableComment: boolean; disableDuet: boolean; disableStitch: boolean; brandOrganic: boolean; brandContent: boolean }

const API = 'https://open.tiktokapis.com/v2';
const CAPTION_MAX = 2200;
const VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm'];
const MAX_BYTES = 4 * 1024 * 1024 * 1024;
const REFRESH_BEFORE = 15 * 60;
const POLLS = 20;

type TtEnv = Pick<Env, 'TIKTOK_CLIENT_KEY' | 'TIKTOK_CLIENT_SECRET'>;
const keys = (env: TtEnv): { key: string; secret: string } | null => (env.TIKTOK_CLIENT_KEY && env.TIKTOK_CLIENT_SECRET ? { key: env.TIKTOK_CLIENT_KEY, secret: env.TIKTOK_CLIENT_SECRET } : null);
export const tiktokConfigured = (env: TtEnv): boolean => keys(env) !== null;

export const tiktokAuthorizeUrl = (env: TtEnv, redirectUri: string, state: string): string =>
  'https://www.tiktok.com/v2/auth/authorize/?' + new URLSearchParams({ client_key: keys(env)!.key, scope: TIKTOK_SCOPE, response_type: 'code', redirect_uri: redirectUri, state }).toString();

export interface TiktokCreds { openId: string; name: string; accessToken: string; accessExpiresAt: number; refreshToken: string; refreshExpiresAt: number }
export type TtExchanged = { ok: true; creds: TiktokCreds } | { ok: false; code: 'failed' | 'no_publish' };

interface TokenAnswer { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; refresh_expires_in?: unknown; open_id?: unknown; scope?: unknown; error?: unknown }

function tokensFrom(d: TokenAnswer | null, now: number): Pick<TiktokCreds, 'accessToken' | 'accessExpiresAt' | 'refreshToken' | 'refreshExpiresAt'> | null {
  if (!d || typeof d.access_token !== 'string' || !d.access_token || typeof d.refresh_token !== 'string' || !d.refresh_token) return null;
  const life = typeof d.expires_in === 'number' && d.expires_in > 0 ? d.expires_in : 86400;
  const rlife = typeof d.refresh_expires_in === 'number' && d.refresh_expires_in > 0 ? d.refresh_expires_in : 365 * 86400;
  return { accessToken: d.access_token, accessExpiresAt: now + life, refreshToken: d.refresh_token, refreshExpiresAt: now + rlife };
}

export async function tiktokExchange(env: TtEnv, redirectUri: string, code: string, now: number): Promise<TtExchanged> {
  const k = keys(env);
  if (!k) return { ok: false, code: 'failed' };
  const t = await callJson<TokenAnswer>(`${API}/oauth/token/`, { method: 'POST', form: { client_key: k.key, client_secret: k.secret, code, grant_type: 'authorization_code', redirect_uri: redirectUri } });
  const td = t.ok ? t.data : null;
  const tokens = tokensFrom(td, now);
  if (!tokens || typeof td?.open_id !== 'string' || !/^[A-Za-z0-9_.-]{6,80}$/.test(td.open_id)) return { ok: false, code: 'failed' };
  const scopes = typeof td.scope === 'string' ? td.scope.split(/[,\s]+/) : null;
  if (scopes && !scopes.includes('video.publish')) return { ok: false, code: 'no_publish' };
  const me = await callJson<{ data?: { user?: { display_name?: unknown } } }>(`${API}/user/info/?fields=open_id,display_name`, { headers: { Authorization: `Bearer ${tokens.accessToken}` } });
  const shown = me.ok ? me.data?.data?.user?.display_name : null;
  const name = typeof shown === 'string' && shown.trim() ? shown.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 60) : 'TikTok account';
  return { ok: true, creds: { openId: td.open_id, name, ...tokens } };
}

export const tiktokBlob = (c: TiktokCreds): string => JSON.stringify({ openId: c.openId, name: c.name, accessToken: c.accessToken, accessExpiresAt: c.accessExpiresAt, refreshToken: c.refreshToken, refreshExpiresAt: c.refreshExpiresAt });

async function load(encrypted: string, key: string): Promise<TiktokCreds | null> {
  try {
    const p = JSON.parse(await decryptToken(encrypted, key));
    if (typeof p?.accessToken !== 'string' || !p.accessToken || typeof p?.refreshToken !== 'string' || typeof p?.openId !== 'string') return null;
    return { openId: p.openId, name: String(p.name ?? ''), accessToken: p.accessToken, accessExpiresAt: Number(p.accessExpiresAt) || 0, refreshToken: p.refreshToken, refreshExpiresAt: Number(p.refreshExpiresAt) || 0 };
  } catch {
    return null;
  }
}

type FreshEnv = Pick<Env, 'DB' | 'ENCRYPTION_KEY' | 'TIKTOK_CLIENT_KEY' | 'TIKTOK_CLIENT_SECRET'>;
type Fresh = { ok: true; creds: TiktokCreds } | { ok: false; error: string };

/** A usable access token for this channel: the stored one, or a new one made from the refresh token (and saved). */
async function freshCreds(env: FreshEnv, channel: { id: string; credentials: string }, now: number): Promise<Fresh> {
  if (!env.ENCRYPTION_KEY) return { ok: false, error: 'Server encryption is not set up.' };
  let c = await load(channel.credentials, env.ENCRYPTION_KEY);
  if (!c) return { ok: false, error: 'The saved TikTok connection is damaged. Disconnect the account and connect it again.' };
  if (c.accessExpiresAt - now > REFRESH_BEFORE) return { ok: true, creds: c };
  const k = keys(env);
  if (!k || (c.refreshExpiresAt && c.refreshExpiresAt <= now)) return { ok: false, error: 'The TikTok connection has expired. Disconnect the account and connect it again.' };
  const r = await callJson<TokenAnswer>(`${API}/oauth/token/`, { method: 'POST', form: { client_key: k.key, client_secret: k.secret, grant_type: 'refresh_token', refresh_token: c.refreshToken } });
  const tokens = r.ok ? tokensFrom(r.data, now) : null;
  if (!tokens) {
    if (r.ok === false && (r.network || r.status >= 500 || r.status === 429)) return { ok: false, error: 'TikTok did not answer. It will be tried again.' };
    return { ok: false, error: 'TikTok no longer accepts the connection. Disconnect the account and connect it again.' };
  }
  c = { ...c, ...tokens };
  await env.DB.prepare('UPDATE video_channels SET credentials = ?2, updated_at = unixepoch() WHERE id = ?1').bind(channel.id, await encryptToken(tiktokBlob(c), env.ENCRYPTION_KEY)).run().catch(() => undefined);
  return { ok: true, creds: c };
}

// ───────────────────────── what this account may do ─────────────────────────
export interface CreatorInfo { nickname: string; username: string; privacyOptions: TiktokPrivacy[]; commentDisabled: boolean; duetDisabled: boolean; stitchDisabled: boolean; maxDurationSec: number | null }
type Err = { code: string; message: string; retryable: boolean };
interface TtBody { data?: Record<string, unknown>; error?: { code?: unknown; message?: unknown } }

const REASON: Record<string, [boolean, string]> = {
  access_token_invalid: [false, 'TikTok no longer accepts the connection. Disconnect the account and connect it again.'],
  scope_not_authorized: [false, 'TikTok did not give Vane permission to post. Disconnect the account and connect it again, allowing video publishing.'],
  scope_permission_missed: [false, 'TikTok did not give Vane permission to post. Disconnect the account and connect it again, allowing video publishing.'],
  rate_limit_exceeded: [true, 'TikTok is rate limiting this account. It will be tried again.'],
  spam_risk_too_many_posts: [false, "This TikTok account reached TikTok's daily posting limit. Try again tomorrow."],
  spam_risk_user_banned_from_posting: [false, 'TikTok has blocked this account from posting.'],
  spam_risk_text: [false, 'TikTok rejected the caption. Change the text and try again.'],
  reached_active_user_cap: [false, "TikTok's daily limit for new posting accounts is reached. Try again later."],
  unaudited_client_can_only_post_to_private_accounts: [false, 'TikTok has not approved Vane yet: until it does, posts can only be "Only me". Choose that, or wait for the approval.'],
  url_ownership_unverified: [false, "TikTok could not verify Vane's video address. The site owner has to confirm it in the TikTok developer portal."],
  privacy_level_option_mismatch: [false, "That visibility is not available for this TikTok account. Choose one from the list."],
  invalid_file_upload: [false, 'TikTok could not read the video file.'],
  file_format_check_failed: [false, 'TikTok does not accept this video format. Use MP4, MOV or WebM (H.264).'],
  duration_check_failed: [false, "The video's length is not allowed by TikTok for this account."],
  frame_rate_check_failed: [false, 'TikTok does not accept this frame rate (it must be between 23 and 60 fps).'],
  picture_size_check_failed: [false, 'TikTok does not accept this video size.'],
  video_pull_failed: [true, 'TikTok could not download the video. It will be tried again.'],
  internal: [true, 'TikTok had a temporary problem. It will be tried again.'],
};

function errorOf(call: { ok: boolean; status: number; data: unknown } | CallErr, networkTrouble = false): Err | null {
  const e = (call.data as TtBody | null)?.error;
  const code = typeof e?.code === 'string' ? e.code : '';
  if (code === 'ok') return null;
  if (!code && call.ok) return null;
  const known = REASON[code];
  if (known) return { code, retryable: known[0], message: known[1] };
  const text = shortMessage({ message: e?.message }, `error ${call.status}`);
  const c = call as CallErr;
  if (networkTrouble || c.network || call.status >= 500 || call.status === 429) return { code: code || 'unavailable', retryable: true, message: 'TikTok did not answer. It will be tried again.' };
  return { code: code || 'refused', retryable: false, message: `TikTok refused the video: ${text}` };
}

type CreatorResult = { ok: true; info: CreatorInfo } | { ok: false; error: string; retryable: boolean };

export async function tiktokCreatorInfo(env: FreshEnv, channel: { id: string; credentials: string }, now = Math.floor(Date.now() / 1000)): Promise<CreatorResult> {
  const f = await freshCreds(env, channel, now);
  if (!f.ok) return { ok: false, error: f.error, retryable: f.error.includes('will be tried again') };
  return creatorWith(f.creds);
}

async function creatorWith(creds: TiktokCreds): Promise<CreatorResult> {
  const f = { creds };
  const r = await callJson<TtBody>(`${API}/post/publish/creator_info/query/`, { method: 'POST', headers: { Authorization: `Bearer ${f.creds.accessToken}` }, json: {} });
  const err = errorOf(r);
  if (err || !r.ok) return { ok: false, error: err?.message ?? 'TikTok did not answer. Try again in a moment.', retryable: err?.retryable ?? true };
  const d = r.data?.data ?? {};
  const levels = Array.isArray(d.privacy_level_options) ? d.privacy_level_options.filter(isTiktokPrivacy) : [];
  return {
    ok: true,
    info: {
      nickname: typeof d.creator_nickname === 'string' && d.creator_nickname ? d.creator_nickname.slice(0, 60) : f.creds.name,
      username: typeof d.creator_username === 'string' ? d.creator_username.replace(/[^A-Za-z0-9_.]/g, '').slice(0, 40) : '',
      privacyOptions: levels,
      commentDisabled: d.comment_disabled === true, duetDisabled: d.duet_disabled === true, stitchDisabled: d.stitch_disabled === true,
      maxDurationSec: typeof d.max_video_post_duration_sec === 'number' ? d.max_video_post_duration_sec : null,
    },
  };
}

// ───────────────────────── the publisher ─────────────────────────
const fail = (retryable: boolean, error: string): PublishOutcome => ({ ok: false, retryable, error });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

const FAIL_REASON: Record<string, string> = {
  file_format_check_failed: 'TikTok does not accept this video format. Use MP4, MOV or WebM (H.264).',
  duration_check_failed: "The video's length is not allowed by TikTok for this account.",
  frame_rate_check_failed: 'TikTok does not accept this frame rate (it must be between 23 and 60 fps).',
  picture_size_check_failed: 'TikTok does not accept this video size.',
  video_pull_failed: 'TikTok could not download the video.',
  publish_cancelled: 'The post was cancelled on TikTok.',
  spam_risk_text: 'TikTok rejected the caption. Change the text and try again.',
  unaudited_client_can_only_post_to_private_accounts: 'TikTok has not approved Vane yet: until it does, posts can only be "Only me".',
};

export function makePublisher(pollMs = 3000): VideoPublisher {
  return {
    async publish(env: PublishEnv, job: PublishJob): Promise<PublishOutcome> {
      const opts = job.options?.tiktok;
      if (!opts) return fail(false, 'Choose who can see the video on TikTok and confirm the TikTok terms, then publish again.');
      if (!VIDEO_TYPES.includes(job.video.contentType)) return fail(false, 'TikTok accepts MP4, MOV and WebM videos. This file is another format.');
      if (job.video.sizeBytes > MAX_BYTES) return fail(false, 'TikTok accepts videos up to 4 GB. This video is larger.');

      const now = Math.floor(Date.now() / 1000);
      const f = await freshCreds(env as FreshEnv, job.channel, now);
      if (!f.ok) return fail(f.error.includes('will be tried again'), f.error);
      const auth = { Authorization: `Bearer ${f.creds.accessToken}` };

      // TikTok decides what this account may choose; a stale or forged choice is refused here, before anything is sent.
      const ci = await creatorWith(f.creds);
      if (!ci.ok) return fail(ci.retryable, ci.error);
      if (!ci.info.privacyOptions.includes(opts.privacy)) return fail(false, 'That visibility is not available for this TikTok account any more. Choose another one and publish again.');
      if (opts.brandContent && opts.privacy === 'SELF_ONLY') return fail(false, 'TikTok does not allow branded content to be "Only me".');

      const caption = (job.description.trim() || job.title.trim()).slice(0, CAPTION_MAX);
      return withPublicLink(env, job.video.id, async (token) => {
        const init = await callJson<TtBody>(`${API}/post/publish/video/init/`, {
          method: 'POST', headers: auth, timeoutMs: 30_000,
          json: {
            post_info: { title: caption, privacy_level: opts.privacy, disable_duet: opts.disableDuet || ci.info.duetDisabled, disable_comment: opts.disableComment || ci.info.commentDisabled, disable_stitch: opts.disableStitch || ci.info.stitchDisabled, brand_organic_toggle: opts.brandOrganic, brand_content_toggle: opts.brandContent },
            source_info: { source: 'PULL_FROM_URL', video_url: productUrl('studio', `/api/video/public/${token}`) },
          },
        });
        const err = errorOf(init);
        if (err) return fail(err.retryable, err.message);
        const publishId = init.ok && typeof init.data?.data?.publish_id === 'string' ? init.data.data.publish_id : '';
        if (!publishId) return fail(true, 'TikTok did not accept the video. It will be tried again.');

        for (let i = 0; i < POLLS; i++) {
          await sleep(pollMs);
          const s = await callJson<TtBody>(`${API}/post/publish/status/fetch/`, { method: 'POST', headers: auth, json: { publish_id: publishId } });
          if (!s.ok) { if (s.status >= 400 && s.status < 500 && s.status !== 429) { const e = errorOf(s); if (e) return fail(false, e.message); } continue; }
          const st = String(s.data?.data?.status ?? '');
          if (st === 'PUBLISH_COMPLETE') {
            const ids = s.data?.data?.publicaly_available_post_id;
            const postId = Array.isArray(ids) && ids.length ? String(ids[0]).replace(/[^0-9]/g, '') : '';
            const user = ci.info.username;
            return { ok: true, externalId: postId || publishId, url: postId && user ? `https://www.tiktok.com/@${user}/video/${postId}` : null };
          }
          if (st === 'FAILED') { const reason = String(s.data?.data?.fail_reason ?? ''); return fail(false, FAIL_REASON[reason] ?? `TikTok could not publish the video${reason ? ` (${reason.replace(/[^a-z_]/g, '').slice(0, 60)})` : ''}.`); }
        }
        // Accepted, still processing: starting again would post it twice, so this is reported as done.
        return { ok: true, externalId: publishId, url: null, note: 'TikTok accepted the video and is still processing it. It will appear on your account shortly.' };
      });
    },
  };
}

export const tiktokPublisher: VideoPublisher = makePublisher();
