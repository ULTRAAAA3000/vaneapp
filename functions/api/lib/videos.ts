/**
 * The video library: reading, editing and deleting a user's videos. Shared by the dashboard (`/api/video/*`, session
 * cookie) and the public API (`/api/v1/video/*`, cvid_ keys), so both always show, accept and reject the same things.
 * Starting and finishing uploads lives in ./videoupload.ts.
 */
import type { Env, VideoPublic, VideoRow, VideoRowJoined } from '../../../types';
import { studioOrigin } from './hosts';
import { fail, isRecord, json, UUID_RE } from './http';

export const MEDIA_OFF = 'Video storage is not enabled on this server yet.';

/** Where the dashboard streams a finished video from: `<base>/<id>/file` (see video/videos/[id]/file.ts). */
export const VIDEO_FILE_BASE = '/api/video/videos';

/** Where public links live: `<studio host>/api/video/public/<token>` (see video/public/[token].ts). */
export const PUBLIC_PATH = '/api/video/public';

/** How a video is shown to whoever asks: the dashboard gets owner-only stream and preview addresses, the public API does not. */
export interface VideoView {
  /** dashboard: where the owner streams the video and its preview; null in the public API */
  fileBase: string | null;
  /** public links are `<linkBase>/<token>` */
  linkBase: string;
}

export const videoView = (request: Request, dashboard: boolean): VideoView => ({
  fileBase: dashboard ? VIDEO_FILE_BASE : null,
  linkBase: `${studioOrigin(request)}${PUBLIC_PATH}`,
});

export const TITLE_MAX = 100;           // YouTube's title limit
export const DESCRIPTION_MAX = 5000;    // YouTube's description limit
export const TAGS_MAX = 30;
export const TAG_MAX_LEN = 40;

/** A video with its optional preview/length and public link. v.* are the video's own columns. */
const SELECT_VIDEO = `
  SELECT v.id, v.user_id, v.title, v.description, v.tags, v.status, v.r2_key, v.content_type, v.size_bytes, v.part_size,
         v.upload_id, v.upload_expires_at, v.error, v.source, v.created_at, v.updated_at, v.completed_at,
         a.thumb_key, a.duration_ms, a.width, a.height, l.token AS link_token
    FROM videos v
    LEFT JOIN video_assets a ON a.video_id = v.id
    LEFT JOIN video_links  l ON l.video_id = v.id`;

/** Private R2 key. A separate prefix from the public `<uuid>.<ext>` post media, which /api/media/:key serves to anyone. */
export const videoKey = (userId: string, videoId: string, ext: 'mp4' | 'mov'): string => `videos/${userId}/${videoId}.${ext}`;

const parseTags = (raw: string): string[] => {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
};

export function toPublicVideo(row: VideoRowJoined, view: VideoView): VideoPublic {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    tags: parseTags(row.tags),
    status: row.status,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    error: row.error,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    uploadExpiresAt: row.status === 'uploading' ? row.upload_expires_at : null,
    fileUrl: view.fileBase && row.status === 'ready' ? `${view.fileBase}/${row.id}/file` : null,
    thumbnailUrl: view.fileBase && row.thumb_key ? `${view.fileBase}/${row.id}/thumbnail` : null,
    durationMs: row.duration_ms,
    width: row.width,
    height: row.height,
    publicUrl: row.link_token ? `${view.linkBase}/${row.link_token}` : null,
  };
}

export async function getVideoRow(env: Env, userId: string, id: string): Promise<VideoRowJoined | null> {
  if (!UUID_RE.test(id)) return null;
  return env.DB.prepare(`${SELECT_VIDEO} WHERE v.id = ?1 AND v.user_id = ?2`).bind(id, userId).first<VideoRowJoined>();
}

// ───────────────────────── title, description, tags ─────────────────────────

export interface VideoMeta {
  title?: string;
  description?: string;
  tags?: string[];
}

const clean = (s: string): string => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();

export type MetaResult = { ok: true; meta: VideoMeta } | { ok: false; response: Response };

/** Checks the optional text fields of a request body. Fields that are absent are simply left out of `meta`. */
export function parseVideoMeta(body: Record<string, unknown>): MetaResult {
  const bad = (message: string): MetaResult => ({ ok: false, response: fail(400, message) });
  const meta: VideoMeta = {};

  if (body.title !== undefined) {
    const title = typeof body.title === 'string' ? clean(body.title.replace(/[\r\n]+/g, ' ')) : '';
    if (!title || title.length > TITLE_MAX) return bad(`title must be 1 to ${TITLE_MAX} characters`);
    meta.title = title;
  }
  if (body.description !== undefined) {
    if (typeof body.description !== 'string') return bad('description must be text');
    const description = clean(body.description);
    if (description.length > DESCRIPTION_MAX) return bad(`description is too long (max ${DESCRIPTION_MAX})`);
    meta.description = description;
  }
  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags) || body.tags.length > TAGS_MAX) return bad(`tags must be a list of up to ${TAGS_MAX} items`);
    const tags: string[] = [];
    for (const t of body.tags) {
      const tag = typeof t === 'string' ? clean(t.replace(/\s+/g, ' ')).replace(/^#/, '') : '';
      if (!tag || tag.length > TAG_MAX_LEN) return bad(`each tag must be 1 to ${TAG_MAX_LEN} characters`);
      if (!tags.some((x) => x.toLowerCase() === tag.toLowerCase())) tags.push(tag);
    }
    meta.tags = tags;
  }
  return { ok: true, meta };
}

// ───────────────────────── library ─────────────────────────

export async function listVideosForUser(env: Env, userId: string, view: VideoView): Promise<Response> {
  // The cap is far above the plan's 90 videos; it only guards against a runaway table.
  const { results } = await env.DB
    .prepare(`${SELECT_VIDEO} WHERE v.user_id = ?1 ORDER BY v.created_at DESC LIMIT 200`)
    .bind(userId)
    .all<VideoRowJoined>();
  return json({ ok: true, videos: results.map((r) => toPublicVideo(r, view)) });
}

export async function getVideoForUser(env: Env, userId: string, id: string, view: VideoView): Promise<Response> {
  const row = await getVideoRow(env, userId, id);
  return row ? json({ ok: true, video: toPublicVideo(row, view) }) : fail(404, 'Video not found');
}

/** Edits title, description and tags. `simulate`: a test key only checks the request and changes nothing. */
export async function updateVideoForUser(env: Env, userId: string, id: string, body: unknown, view: VideoView, simulate = false): Promise<Response> {
  if (!isRecord(body)) return fail(400, 'Body must be a JSON object');
  const parsed = parseVideoMeta(body);
  if (!parsed.ok) return parsed.response;
  const { title, description, tags } = parsed.meta;
  if (title === undefined && description === undefined && tags === undefined) {
    return fail(400, 'Send at least one of: title, description, tags');
  }

  const row = await getVideoRow(env, userId, id);
  if (!row) return fail(404, 'Video not found');
  if (simulate) return json({ ok: true, simulated: true, video: toPublicVideo(row, view) });

  const now = Math.floor(Date.now() / 1000);
  await env.DB
    .prepare('UPDATE videos SET title = ?3, description = ?4, tags = ?5, updated_at = ?6 WHERE id = ?1 AND user_id = ?2')
    .bind(id, userId, title ?? row.title, description ?? row.description, tags ? JSON.stringify(tags) : row.tags, now)
    .run();
  const fresh = await getVideoRow(env, userId, id);
  return fresh ? json({ ok: true, video: toPublicVideo(fresh, view) }) : fail(404, 'Video not found');
}

/** Removes the video, its file in R2 (or its unfinished upload) and its row. `simulate`: a test key changes nothing. */
export async function deleteVideoForUser(env: Env, userId: string, id: string, simulate = false): Promise<Response> {
  const row = await getVideoRow(env, userId, id);
  if (!row) return fail(404, 'Video not found');
  if (simulate) return json({ ok: true, simulated: true });
  if (!env.MEDIA) return fail(503, MEDIA_OFF);

  try {
    if (row.status === 'uploading' && row.upload_id) await env.MEDIA.resumeMultipartUpload(row.r2_key, row.upload_id).abort();
    else await env.MEDIA.delete(row.thumb_key ? [row.r2_key, row.thumb_key] : row.r2_key);
  } catch (err) {
    // An upload R2 already forgot is fine; a real storage outage must not leave a row pointing at a file we kept.
    if (row.status !== 'uploading') {
      console.error('video delete failed', err instanceof Error ? err.message : 'unknown');
      return fail(502, 'Could not delete the file. Please try again.');
    }
  }
  await env.DB.prepare('DELETE FROM videos WHERE id = ?1 AND user_id = ?2').bind(id, userId).run();
  return json({ ok: true });
}

/** How full the library is: videos that count against the plan (finished or being uploaded) and bytes stored. */
export async function videoUsage(env: Env, userId: string): Promise<{ videos: number; storageBytes: number }> {
  const row = await env.DB
    .prepare(
      `SELECT COUNT(*) AS videos,
              COALESCE(SUM(CASE WHEN status = 'ready' THEN size_bytes ELSE 0 END), 0) AS storage
         FROM videos WHERE user_id = ?1 AND status IN ('uploading', 'ready')`,
    )
    .bind(userId)
    .first<{ videos: number; storage: number }>();
  return { videos: row?.videos ?? 0, storageBytes: row?.storage ?? 0 };
}
