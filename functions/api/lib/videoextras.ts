/**
 * The extras of a library video: its preview frame and length (made by the browser while it uploads), and its public link.
 * Shared by the dashboard (`/api/video/videos/:id/thumbnail|link`) and, for links, the public API.
 */
import type { Env } from '../../../types';
import { toB64Url } from './encoding';
import { fail, failCode, json, readBodyLimited } from './http';
import { requireVideoAccess } from './videoplans';
import { serveOwnerPicture } from './videocover';
import { mediaMessage, moderateImages } from './moderation';
import { deleteVideoForUser, getVideoRow, MEDIA_OFF, toPublicVideo, type VideoView } from './videos';

export const THUMB_MAX_BYTES = 300 * 1024;
const MAX_DURATION_MS = 24 * 3600 * 1000;
const MAX_PIXELS = 16384;

const intIn = (raw: string | null, min: number, max: number): number | null | 'bad' => {
  if (raw === null || raw === '') return null;
  const n = /^\d{1,10}$/.test(raw) ? Number(raw) : NaN;
  return Number.isInteger(n) && n >= min && n <= max ? n : 'bad';
};

// ───────────────────────── preview frame + length ─────────────────────────

/**
 * Stores the preview JPEG of a finished video. PUT with the raw JPEG as the body and, optionally, the length and size of
 * the video in the query: `?d=<milliseconds>&w=<pixels>&h=<pixels>`. Sending it again replaces the old one.
 */
export async function putThumbnail(env: Env, userId: string, id: string, request: Request, view: VideoView): Promise<Response> {
  if (!env.MEDIA) return fail(503, MEDIA_OFF);
  const row = await getVideoRow(env, userId, id);
  if (!row) return fail(404, 'Video not found');
  if (row.status !== 'ready') return failCode(409, 'not_ready', 'The preview can be added once the video has finished uploading.');

  const q = new URL(request.url).searchParams;
  const d = intIn(q.get('d'), 0, MAX_DURATION_MS);
  const w = intIn(q.get('w'), 1, MAX_PIXELS);
  const h = intIn(q.get('h'), 1, MAX_PIXELS);
  if (d === 'bad' || w === 'bad' || h === 'bad') return fail(400, 'd (milliseconds), w and h (pixels) must be whole numbers in range');

  if (Number(request.headers.get('content-length') ?? 0) > THUMB_MAX_BYTES) return failCode(413, 'thumbnail_too_large', `The preview can be up to ${THUMB_MAX_BYTES / 1024} KB.`);
  const bytes = await readBodyLimited(request, THUMB_MAX_BYTES);
  if (!bytes) return failCode(413, 'thumbnail_too_large', `The preview can be up to ${THUMB_MAX_BYTES / 1024} KB.`);
  // The type is judged from the bytes (a JPEG starts FF D8 FF), never from the header the client sent.
  if (bytes.length < 128 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return failCode(415, 'unsupported_type', 'The preview must be a JPEG image.');

  // The preview frame is the one picture we get from a Studio video: adult or graphic-violent content takes the whole video down.
  const verdict = await moderateImages(env, [{ bytes, mime: 'image/jpeg' }]);
  if (!verdict.ok) {
    await deleteVideoForUser(env, userId, id);
    return failCode(422, 'video_blocked', `${mediaMessage(verdict.reason, true)} It was removed from your library.`);
  }

  const key = `videos/${userId}/${id}.jpg`;
  await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: 'image/jpeg' }, customMetadata: { userId, videoId: id } });
  await env.DB
    .prepare(
      `INSERT INTO video_assets (video_id, thumb_key, duration_ms, width, height, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(video_id) DO UPDATE SET thumb_key = excluded.thumb_key,
         duration_ms = COALESCE(excluded.duration_ms, video_assets.duration_ms),
         width = COALESCE(excluded.width, video_assets.width), height = COALESCE(excluded.height, video_assets.height),
         updated_at = excluded.updated_at`,
    )
    .bind(id, key, d, w, h, Math.floor(Date.now() / 1000))
    .run();

  const fresh = await getVideoRow(env, userId, id);
  return fresh ? json({ ok: true, video: toPublicVideo(fresh, view) }) : fail(404, 'Video not found');
}

/** The owner's preview image: their cover when they chose one, otherwise the frame taken from the video. */
export const serveThumbnail = serveOwnerPicture;

// ───────────────────────── public link ─────────────────────────

const newToken = (): string => toB64Url(crypto.getRandomValues(new Uint8Array(24)));   // 192 bits → 32 characters

/**
 * Makes the video's public link (or returns the one it already has). Anyone with the address can watch and download the
 * video until the link is removed. Needs an active Vane Studio; removing a link never does.
 * `simulate`: a test key gets the shape of the answer and nothing is created.
 */
export async function createLink(env: Env, userId: string, id: string, view: VideoView, simulate = false): Promise<Response> {
  const row = await getVideoRow(env, userId, id);
  if (!row) return fail(404, 'Video not found');
  if (row.status !== 'ready') return failCode(409, 'not_ready', 'A link can be made once the video has finished uploading.');
  if (simulate) return json({ ok: true, simulated: true, url: `${view.linkBase}/${'x'.repeat(32)}`, video: toPublicVideo(row, view) });

  const denied = await requireVideoAccess(env, userId);
  if (denied) return denied;

  // INSERT OR IGNORE: the UNIQUE video_id makes a second click (or a parallel request) a no-op instead of a second address.
  await env.DB.prepare('INSERT OR IGNORE INTO video_links (token, video_id) VALUES (?1, ?2)').bind(newToken(), id).run();
  const fresh = await getVideoRow(env, userId, id);
  return fresh?.link_token ? json({ ok: true, url: `${view.linkBase}/${fresh.link_token}`, video: toPublicVideo(fresh, view) }, 201) : fail(500, 'Could not create the link. Please try again.');
}

/** Removes the public link: the address stops working at once. */
export async function removeLink(env: Env, userId: string, id: string, view: VideoView, simulate = false): Promise<Response> {
  const row = await getVideoRow(env, userId, id);
  if (!row) return fail(404, 'Video not found');
  if (!simulate) await env.DB.prepare('DELETE FROM video_links WHERE video_id = ?1').bind(id).run();
  const fresh = simulate ? row : await getVideoRow(env, userId, id);
  return json({ ok: true, ...(simulate ? { simulated: true } : {}), video: fresh ? toPublicVideo(fresh, view) : null });
}
