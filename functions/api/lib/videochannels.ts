/**
 * Vane Studio channels: the video networks a video can be published to (YouTube, TikTok, Instagram Reels).
 *
 * The connect flows are not open yet: each network first has to approve Vane (Google brand verification, TikTok's Content
 * Posting API review, Meta business verification: see documentation/SOCIAL_PLATFORMS_VERIFICATION.md §5, §7, §8). Until then the
 * list is empty, the dashboard shows each network as "Soon", and a connect attempt is answered with the reason.
 *
 * TO OPEN A NETWORK once it is approved:
 *   1. set `available: true` below (and update its `note`),
 *   2. add its connect flow in `connectVideoChannel` (OAuth start/callback, encrypted credentials into `video_channels`),
 *   3. in public/assets/studio.js set `ready: true` for it in VNET and add its setup block to the connect dialog.
 * Nothing else has to change: the list, removal and the dashboard are already in place.
 *
 *   GET    /api/video/channels            my video channels and the catalog of networks (with their availability)
 *   POST   /api/video/channels/connect    { platform }   → 409 platform_unavailable until the network is open
 *   DELETE /api/video/channels/:id        disconnect one
 */
import type { Env } from '../../../types';
import { fail, failCode, isRecord, json, UUID_RE } from './http';
import { networkFlags, isOn } from './networks';
import { instagramConfigured } from './instagram';
import { youtubeConfigured } from './youtube';
import { netStartUrl } from './youtubeconnect';

export type VideoPlatform = 'youtube' | 'tiktok' | 'instagram';

export interface VideoPlatformInfo {
  id: VideoPlatform;
  name: string;
  blurb: string;
  /** can an account be connected right now? */
  available: boolean;
  /** why not (shown to the user), or what to expect */
  note: string;
}

export const VIDEO_PLATFORMS: readonly VideoPlatformInfo[] = [
  { id: 'youtube', name: 'YouTube', blurb: 'Videos and Shorts', available: false, note: "Waiting for Google's app verification." },
  { id: 'tiktok', name: 'TikTok', blurb: 'Short videos', available: false, note: "Waiting for TikTok's Content Posting API review." },
  { id: 'instagram', name: 'Instagram Reels', blurb: 'Business and Creator accounts', available: false, note: "Waiting for Meta's business verification and app review." },
];

export interface VideoChannelPublic {
  id: string;
  platform: VideoPlatform;
  name: string;
  isActive: boolean;
  createdAt: number;
}

interface VideoChannelRow {
  id: string;
  platform: VideoPlatform;
  name: string;
  is_active: number;
  created_at: number;
}

/** The catalog as this server sees it: YouTube opens by itself once its Google keys are set (no code change, no redeploy of the page). */
export async function platformsFor(env: Env): Promise<VideoPlatformInfo[]> {
  const flags = await networkFlags(env);
  const open: Partial<Record<VideoPlatform, string>> = {
    ...(youtubeConfigured(env) ? { youtube: 'Until Google approves Vane, YouTube keeps uploads private.' } : {}),
    ...(instagramConfigured(env) ? { instagram: 'Business and Creator accounts only. Reels are always public.' } : {}),
  };
  return VIDEO_PLATFORMS.map((p) => {
    const note = open[p.id];
    if (note === undefined) return p;
    return isOn(p.id, flags) ? { ...p, available: true, note } : { ...p, available: false, note: 'Switched off for now.' };
  });
}

export async function listVideoChannels(env: Env, userId: string): Promise<Response> {
  // Explicit columns: `credentials` is deliberately never selected.
  const { results } = await env.DB
    .prepare('SELECT id, platform, name, is_active, created_at FROM video_channels WHERE user_id = ?1 ORDER BY created_at DESC')
    .bind(userId)
    .all<VideoChannelRow>();
  const channels: VideoChannelPublic[] = results.map((r) => ({ id: r.id, platform: r.platform, name: r.name, isActive: r.is_active === 1, createdAt: r.created_at }));
  return json({ ok: true, channels, platforms: await platformsFor(env) });
}

export async function connectVideoChannel(env: Env, request: Request, body: unknown): Promise<Response> {
  if (!isRecord(body)) return fail(400, 'Body must be a JSON object');
  const info = (await platformsFor(env)).find((p) => p.id === body.platform);
  if (!info) return fail(400, `platform must be one of: ${VIDEO_PLATFORMS.map((p) => p.id).join(', ')}`);
  if (!info.available) return failCode(409, 'platform_unavailable', `${info.name} is not open yet. ${info.note}`);

  // YouTube connects through Google's own page: the dashboard goes to this address (a full page navigation, the callback comes back to it).
  if (info.id === 'youtube' || info.id === 'instagram') return json({ ok: true, redirect: netStartUrl(request, info.id) });

  // A network that is marked available must have its connect flow added here (see the note at the top of this file).
  return failCode(501, 'not_implemented', `${info.name} cannot be connected yet.`);
}

export async function removeVideoChannel(env: Env, userId: string, id: string): Promise<Response> {
  if (!UUID_RE.test(id)) return fail(404, 'Channel not found');
  // Look first, then delete: the database also counts the rows changed by cascades (a channel's publications keep their history,
  // their channel_id is set to NULL), so a count of exactly 1 cannot be relied on to say "it existed".
  const row = await env.DB.prepare('SELECT id FROM video_channels WHERE id = ?1 AND user_id = ?2').bind(id, userId).first<{ id: string }>();
  if (!row) return fail(404, 'Channel not found');
  await env.DB.prepare('DELETE FROM video_channels WHERE id = ?1 AND user_id = ?2').bind(id, userId).run();
  return json({ ok: true });
}
