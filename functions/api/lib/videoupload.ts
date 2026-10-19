/**
 * Chunked, resumable video uploads into R2 (ECONOMY_AND_FINANCE.md §2.5 "Chunked Resumable Uploads через Cloudflare R2").
 * Shared by the dashboard (`/api/video/uploads/*`) and the public API (`/api/v1/video/uploads/*`).
 *
 * The flow, for a file of `size` bytes:
 *
 *   1. start     POST   uploads                  { size, contentType, fileName?, title?, … }
 *                                                → { videoId, partSize, partCount, uploadedParts: [] }
 *   2. send      PUT    uploads/:id/parts/:n     the raw bytes of chunk n (1-based), in any order, retried freely
 *   3. (resume)  GET    uploads/:id              → which chunks R2 already has, so a broken upload continues where it stopped
 *   4. finish    POST   uploads/:id/complete     R2 assembles the file, then it is checked → the video is 'ready'
 *      (cancel)  DELETE uploads/:id              throws the unfinished upload away
 *
 * Why chunks: a Worker request body is limited, and one 2 GB request would fail on any shaky connection.
 * R2's multipart rules shape everything here: every chunk but the last must be the SAME size (>= 5 MiB),
 * so the server fixes PART_SIZE and checks every chunk against the exact length it expects.
 *
 * What is verified: the first chunk must start like a real MP4/MOV whose brand matches the declared type; when the
 * file is assembled its size must equal the declared size and it must contain a `moov` box (a cut-off upload has none).
 * The type is judged from the bytes, never from the file name or the Content-Type header.
 */
import type { R2Bucket } from '@cloudflare/workers-types';
import type { Env, VideoContentType, VideoRow } from '../../../types';
import { fail, failCode, isRecord, json, readBodyLimited } from './http';
import { bump, retryAfter } from './throttle';
import { readBoxHeader, sniffVideoBrand } from './video';
import { requireVideoAccess, VIDEO_ENGINE } from './videoplans';
import { getVideoRow, MEDIA_OFF, parseVideoMeta, TITLE_MAX, toPublicVideo, videoKey, type VideoMeta, type VideoView } from './videos';

export const PART_SIZE = 8 * 1024 * 1024;
export const UPLOAD_TTL_SECONDS = 24 * 3600;

const STARTS_PER_HOUR = 30;
const PARTS_PER_HOUR = 1500;      // ≈ 12 GB an hour: a full 2 GB file is 256 chunks

const EXT: Record<VideoContentType, 'mp4' | 'mov'> = { 'video/mp4': 'mp4', 'video/quicktime': 'mov' };

export const partCount = (size: number): number => Math.ceil(size / PART_SIZE);
/** The exact length chunk `n` (1-based) must have: PART_SIZE, except the last chunk, which is what is left. */
export const partLength = (size: number, n: number): number => (n < partCount(size) ? PART_SIZE : size - PART_SIZE * (partCount(size) - 1));

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

// ───────────────────────── start ─────────────────────────

export interface ValidStart {
  size: number;
  contentType: VideoContentType;
  meta: Required<Pick<VideoMeta, 'title'>> & VideoMeta;
}

export type StartCheck = { ok: true; v: ValidStart } | { ok: false; response: Response };

/** Everything that can be wrong with a "start upload" body (a test key runs exactly this and stops). */
export function validateStart(body: unknown): StartCheck {
  const bad = (response: Response): StartCheck => ({ ok: false, response });
  if (!isRecord(body)) return bad(fail(400, 'Body must be a JSON object'));

  const size = body.size;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) return bad(fail(400, 'size must be the file size in bytes'));
  if (size > VIDEO_ENGINE.maxFileBytes) {
    return bad(failCode(413, 'file_too_large', `Videos can be up to ${VIDEO_ENGINE.maxFileBytes / 1024 ** 3} GB.`));
  }

  const contentType = body.contentType;
  if (contentType !== 'video/mp4' && contentType !== 'video/quicktime') {
    return bad(failCode(415, 'unsupported_type', 'contentType must be "video/mp4" or "video/quicktime" (MP4 or MOV).'));
  }

  const parsed = parseVideoMeta(body);
  if (!parsed.ok) return bad(parsed.response);

  // No title given: take it from the file name ("C:\clips\My trip.mp4" → "My trip").
  let title = parsed.meta.title;
  if (title === undefined) {
    const name = typeof body.fileName === 'string' ? body.fileName.replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '') : '';
    title = name.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX) || 'Untitled video';
  }
  return { ok: true, v: { size, contentType, meta: { ...parsed.meta, title } } };
}

const expiry = (now: number): number => now + UPLOAD_TTL_SECONDS;

/** A test key gets the real answer's shape, with nothing stored and nothing counted. */
export function simulateStart(v: ValidStart): Response {
  const now = nowSeconds();
  return json(
    {
      ok: true,
      simulated: true,
      videoId: crypto.randomUUID(),
      partSize: PART_SIZE,
      partCount: partCount(v.size),
      uploadedParts: [],
      expiresAt: expiry(now),
    },
    201,
  );
}

/** Unfinished uploads past their deadline are thrown away (R2 would drop them after 7 days on its own; this frees the slot sooner). */
async function reapExpiredUploads(env: Env, userId: string, now: number): Promise<void> {
  const { results } = await env.DB
    .prepare(`SELECT id, r2_key, upload_id FROM videos WHERE user_id = ?1 AND status = 'uploading' AND upload_expires_at <= ?2 LIMIT 20`)
    .bind(userId, now)
    .all<Pick<VideoRow, 'id' | 'r2_key' | 'upload_id'>>();
  if (results.length === 0) return;
  for (const r of results) {
    if (r.upload_id && env.MEDIA) await env.MEDIA.resumeMultipartUpload(r.r2_key, r.upload_id).abort().catch(() => undefined);
  }
  const del = env.DB.prepare('DELETE FROM videos WHERE id = ?1');
  await env.DB.batch(results.map((r) => del.bind(r.id)));
}

export async function startUpload(env: Env, userId: string, v: ValidStart, source: 'ui' | 'api', view: VideoView): Promise<Response> {
  if (!env.MEDIA) return fail(503, MEDIA_OFF);
  const denied = await requireVideoAccess(env, userId);
  if (denied) return denied;

  const rl = `vidstart:${userId}`;
  const wait = await retryAfter(env, rl, STARTS_PER_HOUR);
  if (wait) return fail(429, 'Too many uploads started. Try again later.', { 'Retry-After': String(wait) });

  const now = nowSeconds();
  await reapExpiredUploads(env, userId, now);

  const id = crypto.randomUUID();
  const r2Key = videoKey(userId, id, EXT[v.contentType]);
  const upload = await env.MEDIA.createMultipartUpload(r2Key, {
    httpMetadata: { contentType: v.contentType },
    customMetadata: { userId, videoId: id },
  });

  // ONE statement both checks the library limit and inserts, so two uploads started at once cannot both take the last slot.
  let inserted = false;
  try {
    const res = await env.DB
      .prepare(
        `INSERT INTO videos (id, user_id, title, description, tags, status, r2_key, content_type, size_bytes, part_size, upload_id, upload_expires_at, source, created_at, updated_at)
         SELECT ?1, ?2, ?3, ?4, ?5, 'uploading', ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13
          WHERE (SELECT COUNT(*) FROM videos WHERE user_id = ?2 AND status IN ('uploading', 'ready')) < ?14`,
      )
      .bind(
        id, userId, v.meta.title, v.meta.description ?? '', JSON.stringify(v.meta.tags ?? []), r2Key, v.contentType, v.size,
        PART_SIZE, upload.uploadId, expiry(now), source, now, VIDEO_ENGINE.maxVideos,
      )
      .run();
    inserted = res.meta.changes === 1;
  } catch (err) {
    console.error('video insert failed', err instanceof Error ? err.message : 'unknown');
    await upload.abort().catch(() => undefined);
    return fail(500, 'Could not start the upload. Please try again.');
  }
  if (!inserted) {
    await upload.abort().catch(() => undefined);
    return failCode(409, 'video_limit', `Your library is full (${VIDEO_ENGINE.maxVideos} videos). Delete a video to upload another.`);
  }

  await bump(env, rl, 3600);
  const row = await getVideoRow(env, userId, id);
  return json(
    {
      ok: true,
      videoId: id,
      partSize: PART_SIZE,
      partCount: partCount(v.size),
      uploadedParts: [],
      expiresAt: expiry(now),
      video: row ? toPublicVideo(row, view) : null,
    },
    201,
  );
}

// ───────────────────────── one upload: load, status, chunks ─────────────────────────

type Loaded = { ok: true; row: VideoRow } | { ok: false; response: Response };

/** The caller's unfinished upload, or the answer to send instead. */
async function loadUploading(env: Env, userId: string, id: string): Promise<Loaded> {
  const row = await getVideoRow(env, userId, id);
  if (!row) return { ok: false, response: fail(404, 'Upload not found') };
  if (row.status !== 'uploading' || !row.upload_id) return { ok: false, response: failCode(409, 'not_uploading', 'This upload is already finished.') };
  if (row.upload_expires_at !== null && row.upload_expires_at <= nowSeconds()) {
    return { ok: false, response: failCode(410, 'upload_expired', 'This upload expired. Start it again.') };
  }
  return { ok: true, row };
}

async function uploadedPartNumbers(env: Env, videoId: string): Promise<number[]> {
  const { results } = await env.DB
    .prepare('SELECT part_number FROM video_parts WHERE video_id = ?1 ORDER BY part_number')
    .bind(videoId)
    .all<{ part_number: number }>();
  return results.map((r) => r.part_number);
}

/** Where an upload stands: what the client asks after a dropped connection, to send only the chunks that are missing. */
export async function uploadStatus(env: Env, userId: string, id: string, view: VideoView): Promise<Response> {
  const row = await getVideoRow(env, userId, id);
  if (!row) return fail(404, 'Upload not found');
  const parts = row.status === 'uploading' ? await uploadedPartNumbers(env, row.id) : [];
  return json({
    ok: true,
    video: toPublicVideo(row, view),
    partSize: row.part_size,
    partCount: partCount(row.size_bytes),
    uploadedParts: parts,
    expiresAt: row.upload_expires_at,
  });
}

/** Stores chunk `n`. Sending the same chunk again is fine (a retry replaces it). The body is the raw bytes. */
export async function putPart(env: Env, userId: string, id: string, rawN: string, request: Request): Promise<Response> {
  if (!env.MEDIA) return fail(503, MEDIA_OFF);
  const denied = await requireVideoAccess(env, userId);
  if (denied) return denied;

  const loaded = await loadUploading(env, userId, id);
  if (!loaded.ok) return loaded.response;
  const { row } = loaded;

  const total = partCount(row.size_bytes);
  const n = /^\d{1,5}$/.test(rawN) ? Number(rawN) : 0;
  if (n < 1 || n > total) return failCode(404, 'no_such_part', `This upload has ${total} chunks, numbered 1 to ${total}.`);
  const expected = partLength(row.size_bytes, n);

  const rl = `vidpart:${userId}`;
  const wait = await retryAfter(env, rl, PARTS_PER_HOUR);
  if (wait) return fail(429, 'Too many chunks sent. Try again later.', { 'Retry-After': String(wait) });

  if (Number(request.headers.get('content-length') ?? 0) > expected) return failCode(413, 'bad_part_size', `Chunk ${n} must be exactly ${expected} bytes.`);
  const bytes = await readBodyLimited(request, expected);
  if (!bytes) return failCode(413, 'bad_part_size', `Chunk ${n} must be exactly ${expected} bytes.`);
  if (bytes.length !== expected) return failCode(400, 'bad_part_size', `Chunk ${n} must be exactly ${expected} bytes (got ${bytes.length}).`);

  if (n === 1) {
    const kind = sniffVideoBrand(bytes);
    if (!kind) return failCode(415, 'unsupported_type', 'This does not look like an MP4 or MOV video.');
    if (kind.mime !== row.content_type) return failCode(415, 'type_mismatch', `The file is ${kind.mime}, but the upload was started as ${row.content_type}.`);
  }

  let etag: string;
  try {
    etag = (await env.MEDIA.resumeMultipartUpload(row.r2_key, row.upload_id!).uploadPart(n, bytes)).etag;
  } catch (err) {
    console.error('video part failed', err instanceof Error ? err.message : 'unknown');
    return fail(502, 'Storage did not accept the chunk. Please send it again.');
  }

  await env.DB
    .prepare(
      `INSERT INTO video_parts (video_id, part_number, etag, size_bytes) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(video_id, part_number) DO UPDATE SET etag = excluded.etag, size_bytes = excluded.size_bytes`,
    )
    .bind(row.id, n, etag, expected)
    .run();
  await bump(env, rl, 3600);
  return json({ ok: true, partNumber: n, size: expected });
}

// ───────────────────────── finish / cancel ─────────────────────────

/**
 * Does the file have a `moov` box (the index a player needs)? Walks the top-level boxes with tiny range reads, so a
 * 2 GB file is never downloaded: a normal file has a handful of boxes (ftyp, moov, mdat, …).
 */
async function hasMoovBox(bucket: R2Bucket, key: string, size: number): Promise<boolean> {
  let offset = 0;
  for (let guard = 0; guard < 64 && offset + 8 <= size; guard++) {
    const obj = await bucket.get(key, { range: { offset, length: Math.min(16, size - offset) } });
    if (!obj) return false;
    const box = readBoxHeader(new Uint8Array(await obj.arrayBuffer()));
    if (!box) return false;
    if (box.type === 'moov') return true;
    if (box.size === 0) return false;       // "runs to the end of the file", and it is not moov
    if (box.size < 8) return false;
    offset += box.size;
  }
  return false;
}

/** The assembled file is not what the upload promised: delete it and keep the row, marked failed, so the reason is visible. */
async function rejectUpload(env: Env, bucket: R2Bucket, row: VideoRow, message: string): Promise<Response> {
  await bucket.delete(row.r2_key).catch(() => undefined);
  await env.DB.batch([
    env.DB
      .prepare(`UPDATE videos SET status = 'failed', error = ?3, upload_id = NULL, upload_expires_at = NULL, updated_at = ?4 WHERE id = ?1 AND user_id = ?2`)
      .bind(row.id, row.user_id, message, nowSeconds()),
    env.DB.prepare('DELETE FROM video_parts WHERE video_id = ?1').bind(row.id),
  ]);
  return failCode(422, 'invalid_video', message);
}

/** Assembles the chunks into the file, checks it, and makes the video 'ready'. Safe to call twice: a finished video just answers again. */
export async function completeUpload(env: Env, userId: string, id: string, view: VideoView): Promise<Response> {
  if (!env.MEDIA) return fail(503, MEDIA_OFF);
  const denied = await requireVideoAccess(env, userId);
  if (denied) return denied;

  const existing = await getVideoRow(env, userId, id);
  if (!existing) return fail(404, 'Upload not found');
  if (existing.status === 'ready') return json({ ok: true, video: toPublicVideo(existing, view) });
  if (existing.status === 'failed') return failCode(409, 'invalid_video', existing.error ?? 'This upload was rejected.');

  const loaded = await loadUploading(env, userId, id);
  if (!loaded.ok) return loaded.response;
  const { row } = loaded;

  const total = partCount(row.size_bytes);
  const { results: parts } = await env.DB
    .prepare('SELECT part_number, etag FROM video_parts WHERE video_id = ?1 ORDER BY part_number')
    .bind(row.id)
    .all<{ part_number: number; etag: string }>();
  if (parts.length !== total) {
    const have = new Set(parts.map((p) => p.part_number));
    const missing: number[] = [];
    for (let n = 1; n <= total && missing.length < 50; n++) if (!have.has(n)) missing.push(n);
    return failCode(409, 'missing_parts', `${total - parts.length} of ${total} chunks are still missing.`, { missing });
  }

  let size: number;
  try {
    const object = await env.MEDIA.resumeMultipartUpload(row.r2_key, row.upload_id!).complete(parts.map((p) => ({ partNumber: p.part_number, etag: p.etag })));
    size = object.size;
  } catch (err) {
    // A parallel "complete" may have won: then the video is ready and this call just reports it.
    const now = await getVideoRow(env, userId, id);
    if (now?.status === 'ready') return json({ ok: true, video: toPublicVideo(now, view) });
    console.error('video complete failed', err instanceof Error ? err.message : 'unknown');
    return fail(502, 'Storage could not assemble the file. Please try again.');
  }

  if (size !== row.size_bytes) return rejectUpload(env, env.MEDIA, row, `The file is ${size} bytes, but ${row.size_bytes} were declared.`);
  if (!(await hasMoovBox(env.MEDIA, row.r2_key, size))) {
    return rejectUpload(env, env.MEDIA, row, 'The file is not a finished MP4/MOV (it has no "moov" index): the upload may have been cut off.');
  }

  const now = nowSeconds();
  await env.DB.batch([
    env.DB
      .prepare(`UPDATE videos SET status = 'ready', upload_id = NULL, upload_expires_at = NULL, completed_at = ?3, updated_at = ?3 WHERE id = ?1 AND user_id = ?2`)
      .bind(row.id, userId, now),
    env.DB.prepare('DELETE FROM video_parts WHERE video_id = ?1').bind(row.id),
  ]);
  const fresh = await getVideoRow(env, userId, id);
  return fresh ? json({ ok: true, video: toPublicVideo(fresh, view) }) : fail(404, 'Upload not found');
}

/** Cancels an unfinished upload: its chunks in R2 and its row disappear. (A finished video is deleted through the library.) */
export async function cancelUpload(env: Env, userId: string, id: string): Promise<Response> {
  const row = await getVideoRow(env, userId, id);
  if (!row) return fail(404, 'Upload not found');
  if (row.status !== 'uploading') return failCode(409, 'not_uploading', 'This upload is already finished. Delete the video from the library instead.');
  if (!env.MEDIA) return fail(503, MEDIA_OFF);
  if (row.upload_id) await env.MEDIA.resumeMultipartUpload(row.r2_key, row.upload_id).abort().catch(() => undefined);
  await env.DB.prepare('DELETE FROM videos WHERE id = ?1 AND user_id = ?2').bind(row.id, userId).run();
  return json({ ok: true });
}
