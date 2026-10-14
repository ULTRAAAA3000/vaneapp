/**
 * GET /api/media/:key — public, so Telegram's servers can download the image.
 * Safe because keys are random UUIDs and only verified JPEG/PNG/WebP files are ever stored.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { fail, methodNotAllowed } from '../lib/http';

const KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$/;

export const onRequestGet: PagesFunction<Env, 'key'> = async ({ env, params }) => {
  const key = Array.isArray(params.key) ? params.key[0] : params.key;
  if (!env.MEDIA || !key || !KEY_RE.test(key)) return fail(404, 'Not found');

  const obj = await env.MEDIA.get(key);
  if (!obj) return fail(404, 'Not found');

  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
    },
  });
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET');
