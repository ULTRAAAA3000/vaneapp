/**
 * Stream a finished video to its OWNER (the dashboard's player).   GET / HEAD /api/video/videos/:id/file
 *
 * Unlike post media (/api/media/:key, public so Telegram can fetch it), a library video is private: it needs the
 * owner's session. For an address anyone can open, the owner makes a public link (video/videos/[id]/link.ts).
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../../../types';
import { requireUser } from '../../../lib/auth';
import { fail, methodNotAllowed } from '../../../lib/http';
import { streamVideo } from '../../../lib/videofile';
import { getVideoRow } from '../../../lib/videos';

const idOf = (p: string | string[] | undefined) => (Array.isArray(p) ? p[0] : p) ?? '';

async function serve(request: Request, env: Env, id: string, headOnly: boolean): Promise<Response> {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  const row = await getVideoRow(env, auth.userId, id);
  if (!row || row.status !== 'ready') return fail(404, 'Not found');
  return streamVideo(request, env, row, headOnly, { cacheControl: 'private, no-store' });
}

export const onRequestGet: PagesFunction<Env, 'id'> = ({ request, env, params }) => serve(request, env, idOf(params.id), false);
export const onRequestHead: PagesFunction<Env, 'id'> = ({ request, env, params }) => serve(request, env, idOf(params.id), true);
export const onRequest: PagesFunction<Env, 'id'> = async () => methodNotAllowed('GET, HEAD');
