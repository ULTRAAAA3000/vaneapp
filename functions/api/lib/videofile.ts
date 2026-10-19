/**
 * Streams a video from R2 with HTTP Range support (browsers need it to play and seek; platforms use it to resume a download).
 * Shared by the owner's player (`/api/video/videos/:id/file`, needs the session) and by public links (`/api/video/public/:token`).
 */
import type { Env } from '../../../types';
import { fail } from './http';
import { parseRange } from '../media/[key]';

export interface StreamOptions {
  /** Cache-Control: private for the owner, a short public cache for links */
  cacheControl: string;
  /** an extra header or two (e.g. Content-Disposition on public links) */
  headers?: Record<string, string>;
}

export async function streamVideo(
  request: Request,
  env: Env,
  video: { r2_key: string; size_bytes: number; content_type: string },
  headOnly: boolean,
  options: StreamOptions,
): Promise<Response> {
  if (!env.MEDIA) return fail(503, 'Video storage is not enabled on this server yet.');
  const size = video.size_bytes;

  const base: Record<string, string> = {
    'Content-Type': video.content_type,
    'Accept-Ranges': 'bytes',
    'Cache-Control': options.cacheControl,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    ...options.headers,
  };

  const range = parseRange(request.headers.get('range'), size);
  if (range === 'invalid') return new Response(null, { status: 416, headers: { ...base, 'Content-Range': `bytes */${size}` } });

  if (range) {
    const length = range.end - range.start + 1;
    const headers = { ...base, 'Content-Range': `bytes ${range.start}-${range.end}/${size}`, 'Content-Length': String(length) };
    if (headOnly) return new Response(null, { status: 206, headers });
    const obj = await env.MEDIA.get(video.r2_key, { range: { offset: range.start, length } });
    return obj ? new Response(obj.body, { status: 206, headers }) : fail(404, 'Not found');
  }

  const headers = { ...base, 'Content-Length': String(size) };
  if (headOnly) return new Response(null, { status: 200, headers });
  const obj = await env.MEDIA.get(video.r2_key);
  return obj ? new Response(obj.body, { status: 200, headers }) : fail(404, 'Not found');
}
