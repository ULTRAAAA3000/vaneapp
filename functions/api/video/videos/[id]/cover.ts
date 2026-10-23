/**
 * The cover of a video: the picture people see before they press play.
 *
 *   PUT    /api/video/videos/:id/cover    the raw image (JPEG, PNG or WebP, up to 2 MB, at least 160 px)
 *   DELETE /api/video/videos/:id/cover    back to the frame taken from the video
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../../../types';
import { requireUser } from '../../../lib/auth';
import { crossOriginViolation, methodNotAllowed } from '../../../lib/http';
import { putCover, removeCover } from '../../../lib/videocover';
import { videoView } from '../../../lib/videos';

const idOf = (p: string | string[] | undefined) => (Array.isArray(p) ? p[0] : p) ?? '';

export const onRequestPut: PagesFunction<Env, 'id'> = async ({ request, env, params }) => {
  const xo = crossOriginViolation(request);
  if (xo) return xo;
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  return putCover(env, auth.userId, idOf(params.id), request, videoView(request, true));
};

export const onRequestDelete: PagesFunction<Env, 'id'> = async ({ request, env, params }) => {
  const xo = crossOriginViolation(request);
  if (xo) return xo;
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  return removeCover(env, auth.userId, idOf(params.id), videoView(request, true));
};

export const onRequest: PagesFunction<Env, 'id'> = async () => methodNotAllowed('PUT, DELETE');
