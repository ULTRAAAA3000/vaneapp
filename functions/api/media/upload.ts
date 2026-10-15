/**
 * POST /api/media/upload     multipart/form-data with the file in a field named "file"
 *   (a raw request body with the file bytes is accepted too, for scripts)
 *   → 201 { ok, kind: 'image'|'video', key, url, size, contentType, width?, height? }
 *
 * `url` is a public https link (Telegram's servers must be able to download it) and is what the
 * post form sends as `mediaUrl`; `key` is the R2 object key in the `vane-media` bucket.
 *
 * Limits:  images JPEG/PNG/WebP up to 5 MB · videos MP4/MOV up to 20 MB
 *          (Telegram's limits for media fetched by link).
 * Checks, in order: signed-in user → R2 bound → per-user rate limit → body size (read with a hard
 * cap, never fully buffered beyond it) → real file type from the BYTES → image dimensions.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { requireUser } from '../lib/auth';
import { fail, json, methodNotAllowed, readBodyLimited } from '../lib/http';
import { imageSize, sniffImage, telegramPhotoProblem } from '../lib/image';
import { sniffVideo } from '../lib/video';
import { bump, retryAfter } from '../lib/throttle';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 20 * 1024 * 1024;
const MULTIPART_OVERHEAD = 256 * 1024; // boundaries and part headers around the file
const UPLOADS_PER_HOUR = 40;

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  if (!env.MEDIA) return fail(503, 'Media uploads are not enabled on this server yet.');

  const key = `upload:${auth.userId}`;
  const wait = await retryAfter(env, key, UPLOADS_PER_HOUR);
  if (wait) return fail(429, 'Too many uploads. Try again later.', { 'Retry-After': String(wait) });

  const contentType = request.headers.get('content-type') ?? '';
  const multipart = /^multipart\/form-data/i.test(contentType);
  const cap = MAX_VIDEO_BYTES + (multipart ? MULTIPART_OVERHEAD : 0);

  if (Number(request.headers.get('content-length') ?? 0) > cap) return fail(413, 'File is too large (images up to 5 MB, videos up to 20 MB).');
  const body = await readBodyLimited(request, cap);
  if (!body) return fail(413, 'File is too large (images up to 5 MB, videos up to 20 MB).');

  // ── get the file bytes
  let bytes: Uint8Array;
  if (multipart) {
    let part: unknown;
    try {
      const form = await new Response(body, { headers: { 'content-type': contentType } }).formData();
      part = form.get('file');
    } catch {
      return fail(400, 'Could not read the upload form.');
    }
    if (!part || typeof part === 'string' || typeof (part as File).arrayBuffer !== 'function') {
      return fail(400, 'Attach the file in a form field named "file".');
    }
    bytes = new Uint8Array(await (part as File).arrayBuffer());
  } else {
    bytes = body;
  }
  if (bytes.length === 0) return fail(400, 'The file is empty.');

  // ── what is it really? (the Content-Type header and file name are never trusted)
  const image = sniffImage(bytes);
  const video = image ? null : sniffVideo(bytes);
  if (!image && !video) return fail(415, 'Only JPEG, PNG and WebP images and MP4 or MOV videos are supported.');

  let size: { width: number; height: number } | null = null;
  if (image) {
    if (bytes.length > MAX_IMAGE_BYTES) return fail(413, 'Images can be up to 5 MB.');
    size = imageSize(bytes, image);
    if (!size) return fail(422, 'This image file looks damaged and could not be read.');
    const problem = telegramPhotoProblem(size.width, size.height);
    if (problem) return fail(422, problem);
  } else if (bytes.length > MAX_VIDEO_BYTES) {
    return fail(413, 'Videos can be up to 20 MB (Telegram\'s limit for media sent by link).');
  }

  const kind = image ?? video!;
  await bump(env, key, 3600);
  const objectKey = `${crypto.randomUUID()}.${kind.ext}`; // unguessable: the link itself is the capability
  await env.MEDIA.put(objectKey, bytes, {
    httpMetadata: { contentType: kind.mime },
    customMetadata: { userId: auth.userId },
  });

  return json(
    {
      ok: true,
      kind: image ? 'image' : 'video',
      key: objectKey,
      url: `${new URL(request.url).origin}/api/media/${objectKey}`,
      size: bytes.length,
      contentType: kind.mime,
      ...(size ?? {}),
    },
    201,
  );
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('POST');
