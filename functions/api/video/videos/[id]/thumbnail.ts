/**
 * The preview frame of a video (the browser makes it while uploading).
 *
 *   GET /api/video/videos/:id/thumbnail                       the owner's preview image
 *   PUT /api/video/videos/:id/thumbnail?d=<ms>&w=<px>&h=<px>  the raw JPEG (up to 300 KB); d, w, h are optional
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../../../types';
import { requireUser } from '../../../lib/auth';
import { methodNotAllowed } from '../../../lib/http';
import { putThumbnail, serveThumbnail } from '../../../lib/videoextras';
import { videoView } from '../../../lib/videos';

const idOf = (p: string | string[] | undefined) => (Array.isArray(p) ? p[0] : p) ?? '';

export const onRequestGet: PagesFunction<Env, 'id'> = async ({ request, env, params }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  return serveThumbnail(env, auth.userId, idOf(params.id));
};

export const onRequestPut: PagesFunction<Env, 'id'> = async ({ request, env, params }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  return putThumbnail(env, auth.userId, idOf(params.id), request, videoView(request, true));
};

export const onRequest: PagesFunction<Env, 'id'> = async () => methodNotAllowed('GET, PUT');
