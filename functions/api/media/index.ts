/**
 * POST /api/media   raw image bytes, Content-Type: image/jpeg | image/png | image/webp
 *   → { ok, url, key }   where url is a public https link Telegram can fetch.
 *
 * Needs the R2 binding `MEDIA` (see wrangler.toml). Without it the dashboard simply hides
 * the upload button and users paste an image link instead.
 *
 * The file type is verified from the file's own bytes, not from the header the client sent.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { requireUser } from '../lib/auth';
import { fail, json, methodNotAllowed } from '../lib/http';
import { bump, retryAfter } from '../lib/throttle';

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // Telegram fetches URL photos up to 5 MB

export function sniffImage(b: Uint8Array): { ext: 'jpg' | 'png' | 'webp'; mime: string } | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (b.length > 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v)) return { ext: 'png', mime: 'image/png' };
  if (b.length > 12 && String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  return null;
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  if (!env.MEDIA) return fail(503, 'Uploads are not enabled on this deployment. Paste an image link instead.');

  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_UPLOAD_BYTES) return fail(413, 'Image is too large (max 5 MB).');

  const key = `upload:${auth.userId}`;
  const wait = await retryAfter(env, key, 40);
  if (wait) return fail(429, 'Too many uploads. Try again later.', { 'Retry-After': String(wait) });

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length === 0) return fail(400, 'Empty file.');
  if (bytes.length > MAX_UPLOAD_BYTES) return fail(413, 'Image is too large (max 5 MB).');

  const kind = sniffImage(bytes);
  if (!kind) return fail(415, 'Only JPEG, PNG and WebP images are supported.');

  await bump(env, key, 3600);
  const objectKey = `${crypto.randomUUID()}.${kind.ext}`; // unguessable: the link itself is the capability
  await env.MEDIA.put(objectKey, bytes, {
    httpMetadata: { contentType: kind.mime },
    customMetadata: { userId: auth.userId },
  });

  const origin = new URL(request.url).origin;
  return json({ ok: true, key: objectKey, url: `${origin}/api/media/${objectKey}` }, 201);
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('POST');
