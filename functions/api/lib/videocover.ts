/**
 * A video's cover: the picture a person chose to represent it (the frame the browser takes while uploading is only the fallback).
 *
 *   putCover      PUT the raw image (JPEG, PNG or WebP, up to 2 MB). The type is judged from the bytes, the whole file is checked
 *                 like every library upload (nothing hidden after the picture), and the size must be sensible for a thumbnail.
 *   removeCover   back to the frame taken from the video
 *   serveCover    the owner's picture (the cover when there is one, otherwise the frame), and the public one behind a video link
 *
 * It can be set before the upload finishes (the picture is kept next to the video) or any time after.
 * Publishers receive the cover through `PublishJob.video.cover` (see videopublishers.ts).
 */
import type { Env } from '../../../types';
import { fail, failCode, json, readBodyLimited } from './http';
import { imageSize, sniffImage } from './image';
import { imageProblem } from './mediacheck';
import { bump, retryAfter } from './throttle';
import { getVideoRow, MEDIA_OFF, toPublicVideo, type VideoView } from './videos';

export const COVER_MAX_BYTES = 2 * 1024 * 1024;
const MIN_SIDE = 160;
const MAX_SIDE = 8000;
const COVERS_PER_HOUR = 60;

export const coverKey = (userId: string, videoId: string, ext: string): string => `videos/${userId}/${videoId}.cover.${ext}`;

/** Stores or replaces the cover. `simulate`: a test key checks the picture and changes nothing. */
export async function putCover(env: Env, userId: string, id: string, request: Request, view: VideoView, simulate = false): Promise<Response> {
  if (!env.MEDIA) return fail(503, MEDIA_OFF);
  const row = await getVideoRow(env, userId, id);
  if (!row) return fail(404, 'Video not found');
  if (row.status === 'failed') return failCode(409, 'video_failed', 'This video was rejected, so it cannot have a cover.');

  const key = `cover:${userId}`;
  const wait = await retryAfter(env, key, COVERS_PER_HOUR);
  if (wait) return failCode(429, 'rate_limited', 'Too many cover uploads. Try again later.', { retryAfter: wait }, { 'Retry-After': String(wait) });

  const tooBig = () => failCode(413, 'cover_too_large', `The cover can be up to ${COVER_MAX_BYTES / 1024 / 1024} MB.`);
  if (Number(request.headers.get('content-length') ?? 0) > COVER_MAX_BYTES) return tooBig();
  const bytes = await readBodyLimited(request, COVER_MAX_BYTES);
  if (!bytes) return tooBig();

  const kind = sniffImage(bytes);                                    // never the Content-Type header or a file name
  if (!kind) return failCode(415, 'unsupported_type', 'The cover must be a JPEG, PNG or WebP picture.');
  if (imageProblem(bytes, kind)) return failCode(422, 'bad_image', 'This file is not a clean picture. Export it again and upload the new file.');
  const size = imageSize(bytes, kind);
  if (!size) return failCode(422, 'bad_image', 'This picture looks damaged and could not be read.');
  if (Math.min(size.width, size.height) < MIN_SIDE) return failCode(422, 'cover_too_small', `The cover must be at least ${MIN_SIDE} pixels on its short side.`);
  if (Math.max(size.width, size.height) > MAX_SIDE) return failCode(422, 'cover_too_large_pixels', `The cover can be at most ${MAX_SIDE} pixels on its long side.`);

  if (simulate) return json({ ok: true, simulated: true, video: toPublicVideo(row, view) });
  await bump(env, key, 3600);

  const newKey = coverKey(userId, id, kind.ext);
  await env.MEDIA.put(newKey, bytes, { httpMetadata: { contentType: kind.mime }, customMetadata: { userId, videoId: id } });
  if (row.cover_key && row.cover_key !== newKey) await env.MEDIA.delete(row.cover_key).catch(() => undefined);   // another format replaced it
  await env.DB
    .prepare(
      `INSERT INTO video_covers (video_id, r2_key, content_type, width, height, size_bytes, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, unixepoch())
       ON CONFLICT(video_id) DO UPDATE SET r2_key = excluded.r2_key, content_type = excluded.content_type, width = excluded.width,
         height = excluded.height, size_bytes = excluded.size_bytes, updated_at = excluded.updated_at`,
    )
    .bind(id, newKey, kind.mime, size.width, size.height, bytes.length)
    .run();

  const fresh = await getVideoRow(env, userId, id);
  return fresh ? json({ ok: true, video: toPublicVideo(fresh, view) }) : fail(404, 'Video not found');
}

export async function removeCover(env: Env, userId: string, id: string, view: VideoView, simulate = false): Promise<Response> {
  if (!env.MEDIA) return fail(503, MEDIA_OFF);
  const row = await getVideoRow(env, userId, id);
  if (!row) return fail(404, 'Video not found');
  if (simulate || !row.cover_key) return json({ ok: true, ...(simulate ? { simulated: true } : {}), video: toPublicVideo(row, view) });
  try { await env.MEDIA.delete(row.cover_key); } catch {
    return fail(502, 'Could not remove the cover. Please try again.');
  }
  await env.DB.prepare('DELETE FROM video_covers WHERE video_id = ?1').bind(id).run();
  const fresh = await getVideoRow(env, userId, id);
  return fresh ? json({ ok: true, video: toPublicVideo(fresh, view) }) : fail(404, 'Video not found');
}

function imageResponse(obj: { body: ReadableStream; size: number }, contentType: string, cache: string, headOnly: boolean): Response {
  return new Response(headOnly ? null : (obj.body as unknown as BodyInit), {
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(obj.size),
      'Cache-Control': cache,
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex, nofollow',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    },
  });
}

/** The cover behind a public video link (the link is the permission; no cover means 404). */
export async function servePublicCover(env: Env, token: string, headOnly: boolean): Promise<Response> {
  if (!env.MEDIA) return fail(404, 'Not found');
  const row = await env.DB
    .prepare(
      `SELECT c.r2_key, c.content_type FROM video_links l JOIN videos v ON v.id = l.video_id JOIN video_covers c ON c.video_id = v.id
        WHERE l.token = ?1 AND v.status = 'ready'`,
    )
    .bind(token)
    .first<{ r2_key: string; content_type: string }>()
    .catch(() => null);
  if (!row) return fail(404, 'Not found');
  const obj = await env.MEDIA.get(row.r2_key);
  return obj ? imageResponse(obj, row.content_type, 'public, max-age=300', headOnly) : fail(404, 'Not found');
}

/** The owner's picture: the cover when there is one, otherwise the frame. */
export async function serveOwnerPicture(env: Env, userId: string, id: string): Promise<Response> {
  if (!env.MEDIA) return fail(503, MEDIA_OFF);
  const row = await getVideoRow(env, userId, id);
  if (!row) return fail(404, 'Not found');
  const key = row.cover_key ?? row.thumb_key;
  if (!key) return fail(404, 'Not found');
  const obj = await env.MEDIA.get(key);
  if (!obj) return fail(404, 'Not found');
  return imageResponse(obj, row.cover_key ? row.cover_type ?? 'image/jpeg' : 'image/jpeg', 'private, no-cache', false);
}
