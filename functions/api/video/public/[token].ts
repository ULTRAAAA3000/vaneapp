/**
 * Open a public video link.   GET / HEAD /api/video/public/:token     (no sign-in: the token IS the permission)
 *
 * The owner makes the link, and can remove it at any moment. Supports Range requests, so players seek and downloads resume.
 * What the token cannot do: it shows exactly one video, and nothing else about the account.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../../types';
import { fail, methodNotAllowed } from '../../lib/http';
import { isVideoChecked } from '../../lib/videocheck';
import { streamVideo } from '../../lib/videofile';

const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;

async function serve(request: Request, env: Env, rawToken: string | string[] | undefined, headOnly: boolean): Promise<Response> {
  const token = Array.isArray(rawToken) ? rawToken[0] : rawToken;
  if (!token || !TOKEN_RE.test(token)) return fail(404, 'Not found');

  const video = await env.DB
    .prepare(
      `SELECT v.id, v.r2_key, v.size_bytes, v.content_type, v.title
         FROM video_links l JOIN videos v ON v.id = l.video_id
        WHERE l.token = ?1 AND v.status = 'ready'`,
    )
    .bind(token)
    .first<{ id: string; r2_key: string; size_bytes: number; content_type: string; title: string }>();
  if (!video || !(await isVideoChecked(env, video.id))) return fail(404, 'Not found');   // a video nobody has looked at is never shown

  // A file name for "Save as": the title without anything that could break a header.
  const base = video.title.replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 80) || 'video';
  const ext = video.content_type === 'video/quicktime' ? 'mov' : 'mp4';
  return streamVideo(request, env, video, headOnly, {
    cacheControl: 'public, max-age=300',
    headers: {
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(`${base}.${ext}`)}`,
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}

export const onRequestGet: PagesFunction<Env, 'token'> = ({ request, env, params }) => serve(request, env, params.token, false);
export const onRequestHead: PagesFunction<Env, 'token'> = ({ request, env, params }) => serve(request, env, params.token, true);
export const onRequest: PagesFunction<Env, 'token'> = async () => methodNotAllowed('GET, HEAD');
