/**
 * Vane Studio → Vane Post hand-off: "announce this video" (ECONOMY_AND_FINANCE.md §3).
 *
 * The two products have their own dashboards and their own API slices (studio. cannot call the posting endpoints), so the
 * hand-off happens HERE, on the server: Studio asks, and this module writes the post through the very same code the posting
 * dashboard uses (validateCreatePost + insertPostGroup + countUiPosts). The rules, limits, quota counting and delivery are
 * therefore exactly those of a post made in Vane Post. The post goes out within a minute (the worker's next round).
 *
 *   GET  /api/video/announce                  my channels, to choose from (never their credentials)
 *   POST /api/video/videos/:id/announce       { text, channelIds }
 *        "{link}" in the text becomes the video's public link (made on the spot when the video has none)
 *        → 201 { ok, groupId, channels, text, url }
 */
import type { Env } from '../../../types';
import { channelsForUser } from '../channels/index';
import { insertPostGroup, validateCreatePost } from '../posts/create';
import { toB64Url } from './encoding';
import { fail, failCode, isRecord, json } from './http';
import { postUnits } from './plans';
import { countUiPosts } from './usage';
import { requireVideoAccess } from './videoplans';
import { getVideoRow, type VideoView } from './videos';

export const LINK_PLACEHOLDER = '{link}';
/** How soon the post is due: the posting side needs a future time, and the worker delivers on its next round. */
const LEAD_SECONDS = 5;

export async function listAnnounceChannels(env: Env, userId: string): Promise<Response> {
  return json({ ok: true, channels: await channelsForUser(env, userId) });
}

export async function announceVideo(env: Env, userId: string, id: string, body: unknown, view: VideoView): Promise<Response> {
  if (!isRecord(body)) return fail(400, 'Body must be a JSON object');
  if (typeof body.text !== 'string' || !body.text.trim()) return fail(400, 'text is required');

  const video = await getVideoRow(env, userId, id);
  if (!video) return fail(404, 'Video not found');
  if (video.status !== 'ready') return failCode(409, 'not_ready', 'A video can be announced once it has finished uploading.');
  const denied = await requireVideoAccess(env, userId);
  if (denied) return denied;

  // The link: the video's own, or a new one that is written in the SAME batch as the posts (all or nothing). The text is
  // checked with the real address in it, so the length limits of every network are judged on what will actually be posted.
  const wantsLink = body.text.includes(LINK_PLACEHOLDER);
  const newToken = wantsLink && !video.link_token ? toB64Url(crypto.getRandomValues(new Uint8Array(24))) : null;
  const token = video.link_token ?? newToken;
  const url = token ? `${view.linkBase}/${token}` : null;
  const content = wantsLink && url ? body.text.split(LINK_PLACEHOLDER).join(url) : body.text;

  const checked = await validateCreatePost(env, userId, {
    content,
    channelIds: body.channelIds,
    scheduledAt: Math.floor(Date.now() / 1000) + LEAD_SECONDS,
  });
  if (!checked.ok) return checked.response;
  const v = checked.v;

  const saved = await insertPostGroup(env, userId, v, () =>
    // A plain INSERT on purpose: if another request made a link for this video meanwhile, the unique video_id makes the
    // whole batch fail, and nothing is posted with an address that would not be the video's link.
    newToken ? [env.DB.prepare('INSERT INTO video_links (token, video_id) VALUES (?1, ?2)').bind(newToken, id)] : [],
  );
  if (!saved.ok) {
    return newToken
      ? failCode(409, 'link_changed', 'The video link changed while posting. Please try again.')
      : fail(500, 'Could not schedule the announcement. Please try again.');
  }

  await countUiPosts(env, userId, postUnits(v.channels.length));
  return json({ ok: true, groupId: saved.groupId, channels: v.channels.length, text: content, url: wantsLink ? url : null, scheduledAt: v.scheduledAt }, 201);
}
