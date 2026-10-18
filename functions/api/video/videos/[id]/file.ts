/**
 * Stream a finished video to its OWNER (the dashboard's player).   GET / HEAD /api/video/videos/:id/file
 *
 * Unlike post media (/api/media/:key, public so Telegram can fetch it), a library video is private: it needs the
 * owner's session. Supports HTTP Range requests, which browsers need to play and seek.
 * Public links for the networks that pull a file by URL (TikTok) are a later part.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../../../types';
import { requireUser } from '../../../lib/auth';
import { fail, methodNotAllowed } from '../../../lib/http';
import { getVideoRow } from '../../../lib/videos';
import { parseRange } from '../../../media/[key]';

const idOf = (p: string | string[] | undefined) => (Array.isArray(p) ? p[0] : p) ?? '';

async function serve(request: Request, env: Env, id: string, headOnly: boolean): Promise<Response> {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  if (!env.MEDIA) return fail(503, 'Video storage is not enabled on this server yet.');

  const row = await getVideoRow(env, auth.userId, id);
  if (!row || row.status !== 'ready') return fail(404, 'Not found');
  const size = row.size_bytes;

  const base: Record<string, string> = {
    'Content-Type': row.content_type,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  };

  const range = parseRange(request.headers.get('range'), size);
  if (range === 'invalid') return new Response(null, { status: 416, headers: { ...base, 'Content-Range': `bytes */${size}` } });

  if (range) {
    const length = range.end - range.start + 1;
    const headers = { ...base, 'Content-Range': `bytes ${range.start}-${range.end}/${size}`, 'Content-Length': String(length) };
    if (headOnly) return new Response(null, { status: 206, headers });
    const obj = await env.MEDIA.get(row.r2_key, { range: { offset: range.start, length } });
    return obj ? new Response(obj.body, { status: 206, headers }) : fail(404, 'Not found');
  }

  const headers = { ...base, 'Content-Length': String(size) };
  if (headOnly) return new Response(null, { status: 200, headers });
  const obj = await env.MEDIA.get(row.r2_key);
  return obj ? new Response(obj.body, { status: 200, headers }) : fail(404, 'Not found');
}

export const onRequestGet: PagesFunction<Env, 'id'> = ({ request, env, params }) => serve(request, env, idOf(params.id), false);
export const onRequestHead: PagesFunction<Env, 'id'> = ({ request, env, params }) => serve(request, env, idOf(params.id), true);
export const onRequest: PagesFunction<Env, 'id'> = async () => methodNotAllowed('GET, HEAD');
