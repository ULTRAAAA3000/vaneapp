/**
 * GET / HEAD /api/media/:key — public, so Telegram's servers and the dashboard preview can fetch it.
 * Safe because keys are random UUIDs and only verified JPEG/PNG/WebP/MP4/MOV files are ever stored.
 *
 * Supports HTTP Range requests: browsers need them to play and seek videos, and some downloaders
 * (Telegram's included) use them.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { fail, methodNotAllowed } from '../lib/http';

const KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|mp4|mov)$/;
const MIME: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', mp4: 'video/mp4', mov: 'video/quicktime' };

/** `Range: bytes=…` → absolute byte window, 'invalid' (→ 416) or null (no/ignored header). */
export function parseRange(header: string | null, size: number): { start: number; end: number } | 'invalid' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());   // multi-range requests are ignored → full body
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start: number, end: number;
  if (m[1] === '') {                                       // suffix: last N bytes
    const n = Number(m[2]);
    if (n === 0) return 'invalid';
    start = Math.max(0, size - n); end = size - 1;
  } else {
    start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return 'invalid';
  return { start, end };
}

async function serve(request: Request, env: Env, rawKey: string | string[] | undefined, headOnly: boolean): Promise<Response> {
  const key = Array.isArray(rawKey) ? rawKey[0] : rawKey;
  if (!env.MEDIA || !key || !KEY_RE.test(key)) return fail(404, 'Not found');

  const head = await env.MEDIA.head(key);
  if (!head) return fail(404, 'Not found');
  const size = head.size;

  const base: Record<string, string> = {
    'Content-Type': MIME[key.split('.').pop()!],
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  };

  const range = parseRange(request.headers.get('range'), size);
  if (range === 'invalid') return new Response(null, { status: 416, headers: { ...base, 'Content-Range': `bytes */${size}` } });

  if (range) {
    const length = range.end - range.start + 1;
    const headers = { ...base, 'Content-Range': `bytes ${range.start}-${range.end}/${size}`, 'Content-Length': String(length) };
    if (headOnly) return new Response(null, { status: 206, headers });
    const obj = await env.MEDIA.get(key, { range: { offset: range.start, length } });
    return obj ? new Response(obj.body, { status: 206, headers }) : fail(404, 'Not found');
  }

  const headers = { ...base, 'Content-Length': String(size) };
  if (headOnly) return new Response(null, { status: 200, headers });
  const obj = await env.MEDIA.get(key);
  return obj ? new Response(obj.body, { status: 200, headers }) : fail(404, 'Not found');
}

export const onRequestGet: PagesFunction<Env, 'key'> = ({ request, env, params }) => serve(request, env, params.key, false);
export const onRequestHead: PagesFunction<Env, 'key'> = ({ request, env, params }) => serve(request, env, params.key, true);
export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET, HEAD');
