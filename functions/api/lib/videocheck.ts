/**
 * The content check of a Studio video. The server cannot decode video, so the browser (or the API client) sends frames taken
 * from it; every frame is judged on its own and one flagged frame removes the video. Only a video that passed has a row in
 * `video_checks`, and only such a video can be published or get a public link: a video nobody looked at is never shared.
 *
 *   POST /api/video/videos/:id/frames        multipart, 3 to 8 JPEGs in fields named "frame"  → { ok, video }
 *   POST /api/v1/video/videos/:id/frames     the same for the public API (a test key judges the frames and stores nothing)
 *
 * If our checker cannot answer, the answer is 503 `media_unchecked` and the video stays (send the frames again).
 */
import type { Env } from '../../../types';
import { fail, failCode, json, readBodyLimited } from './http';
import { sniffImage } from './image';
import { isMissingSchema } from './integrations';
import { mediaCode, mediaMessage, mediaStatus, moderateImages, type Picture } from './moderation';
import { framesNeeded, MAX_FRAMES } from './videoframes';
import { deleteVideoForUser, getVideoRow, toPublicVideo, type VideoView } from './videos';

const FRAME_MAX_BYTES = 300 * 1024;
const FORM_OVERHEAD = 256 * 1024;   // boundaries and part headers
export const NOT_CHECKED_MESSAGE = 'This video has not passed the content check yet. Upload it again from the Vane app (it sends the frames to check by itself); through the API, send 3 to 8 frames to /videos/:id/frames.';

/** What the gate needs: the publishing cron job has no full `Env`, only a database (and, locally, the switch that turns checks off). */
type GateEnv = Pick<Env, 'DB' | 'MODERATION_OFF'>;

/** True when the video passed the check. A database without the table yet (schema.sql not run) counts as "not checked": it fails closed. */
export async function isVideoChecked(env: GateEnv, id: string): Promise<boolean> {
  if (env.MODERATION_OFF === '1') return true;
  try {
    return (await env.DB.prepare('SELECT 1 AS ok FROM video_checks WHERE video_id = ?1').bind(id).first<{ ok: number }>()) !== null;
  } catch (err) {
    if (!isMissingSchema(err)) throw err;
    console.error('video_checks is missing: run schema.sql');
    return false;
  }
}

/** The refusal for a video that has not been checked, or null when it may go on. */
export async function notCheckedProblem(env: GateEnv, id: string): Promise<Response | null> {
  return (await isVideoChecked(env, id)) ? null : failCode(409, 'not_checked', NOT_CHECKED_MESSAGE);
}

export async function putFrames(env: Env, userId: string, id: string, request: Request, view: VideoView, simulate = false): Promise<Response> {
  const row = await getVideoRow(env, userId, id);
  if (!row) return fail(404, 'Video not found');
  if (row.status !== 'ready') return failCode(409, 'not_ready', 'The frames can be sent once the video has finished uploading.');

  const contentType = request.headers.get('content-type') ?? '';
  if (!/^multipart\/form-data/i.test(contentType)) return failCode(415, 'unsupported_type', 'Send the frames as multipart/form-data, in fields named "frame".');
  const cap = MAX_FRAMES * FRAME_MAX_BYTES + FORM_OVERHEAD;
  if (Number(request.headers.get('content-length') ?? 0) > cap) return failCode(413, 'frames_too_large', 'The frames are too large (each up to 300 KB).');
  const body = await readBodyLimited(request, cap);
  if (!body) return failCode(413, 'frames_too_large', 'The frames are too large (each up to 300 KB).');

  const pics: Picture[] = [];
  try {
    const form = await new Response(body, { headers: { 'content-type': contentType } }).formData();
    for (const f of form.getAll('frame').slice(0, MAX_FRAMES)) {
      if (typeof f === 'string' || typeof (f as File).arrayBuffer !== 'function' || (f as File).size > FRAME_MAX_BYTES) continue;
      const bytes = new Uint8Array(await (f as File).arrayBuffer());
      const kind = sniffImage(bytes);                                // never the Content-Type or the file name
      if (kind) pics.push({ bytes, mime: kind.mime });
    }
  } catch {
    return failCode(400, 'bad_form', 'Could not read the frames form.');
  }
  const need = framesNeeded(row.duration_ms ? row.duration_ms / 1000 : null);
  if (pics.length < need) return failCode(422, 'frames_required', `Send at least ${need} frames (JPEG, PNG or WebP, up to 300 KB each) taken from different places of the video; ${pics.length} usable.`);

  const verdict = await moderateImages(env, pics);
  if (!verdict.ok) {
    if (verdict.reason === 'unchecked') return failCode(mediaStatus(verdict.reason), mediaCode(verdict.reason), mediaMessage(verdict.reason, true));
    if (!simulate) await deleteVideoForUser(env, userId, id);
    return failCode(422, 'video_blocked', `${mediaMessage(verdict.reason, true)}${simulate ? '' : ' It was removed from your library.'}`);
  }
  if (simulate) return json({ ok: true, simulated: true, video: toPublicVideo(row, view) });

  await env.DB
    .prepare(`INSERT INTO video_checks (video_id, frames, checked_at) VALUES (?1, ?2, unixepoch()) ON CONFLICT(video_id) DO UPDATE SET frames = excluded.frames, checked_at = excluded.checked_at`)
    .bind(id, pics.length)
    .run();
  const fresh = await getVideoRow(env, userId, id);
  return json({ ok: true, frames: pics.length, video: fresh ? toPublicVideo(fresh, view) : null });
}
