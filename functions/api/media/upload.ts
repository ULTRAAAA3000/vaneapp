/**
 * POST /api/media/upload    raw image bytes in the body (Content-Type: image/jpeg|png|webp)
 *   → 201 { ok, key, url, size, width, height, contentType }
 *
 * `url` is a public https link (Telegram's servers must be able to download it) and is what the
 * post form sends as `mediaUrl`; `key` is the R2 object key.
 *
 * Checks, in order: signed-in user → R2 bound → size → per-user rate limit → real file type
 * (from the bytes) → readable dimensions that Telegram accepts.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { requireUser } from '../lib/auth';
import { fail, json, methodNotAllowed } from '../lib/http';
import { imageSize, sniffImage, telegramPhotoProblem } from '../lib/image';
import { bump, retryAfter } from '../lib/throttle';

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // Telegram downloads photos by URL up to 5 MB
const UPLOADS_PER_HOUR = 40;

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  if (!env.MEDIA) return fail(503, 'Image uploads are not enabled on this server yet. Paste an image link instead.');

  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_UPLOAD_BYTES) return fail(413, 'Image is too large (max 5 MB).');

  const key = `upload:${auth.userId}`;
  const wait = await retryAfter(env, key, UPLOADS_PER_HOUR);
  if (wait) return fail(429, 'Too many uploads. Try again later.', { 'Retry-After': String(wait) });

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length === 0) return fail(400, 'The file is empty.');
  if (bytes.length > MAX_UPLOAD_BYTES) return fail(413, 'Image is too large (max 5 MB).');

  const kind = sniffImage(bytes);
  if (!kind) return fail(415, 'Only JPEG, PNG and WebP images are supported.');

  const size = imageSize(bytes, kind);
  if (!size) return fail(422, 'This image file looks damaged and could not be read.');
  const problem = telegramPhotoProblem(size.width, size.height);
  if (problem) return fail(422, problem);

  await bump(env, key, 3600);
  const objectKey = `${crypto.randomUUID()}.${kind.ext}`; // unguessable: the link itself is the capability
  await env.MEDIA.put(objectKey, bytes, {
    httpMetadata: { contentType: kind.mime },
    customMetadata: { userId: auth.userId },
  });

  return json(
    {
      ok: true,
      key: objectKey,
      url: `${new URL(request.url).origin}/api/media/${objectKey}`,
      size: bytes.length,
      width: size.width,
      height: size.height,
      contentType: kind.mime,
    },
    201,
  );
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('POST');
