/**
 * Public API: the cover of a video.
 *
 *   PUT    /api/v1/video/videos/:id/cover    the raw image as the body (JPEG, PNG or WebP, up to 2 MB, at least 160 px on the short side)
 *   DELETE /api/v1/video/videos/:id/cover    back to the frame taken from the video
 * A test key checks the picture and changes nothing.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../../../../types';
import { requireApiKey } from '../../../../lib/apikeys';
import { methodNotAllowed } from '../../../../lib/http';
import { putCover, removeCover } from '../../../../lib/videocover';
import { videoView } from '../../../../lib/videos';

const idOf = (p: string | string[] | undefined) => (Array.isArray(p) ? p[0] : p) ?? '';

export const onRequestPut: PagesFunction<Env, 'id'> = async ({ request, env, params }) => {
  const auth = await requireApiKey(request, env, 'video');
  if (!auth.ok) return auth.response;
  return putCover(env, auth.userId, idOf(params.id), request, videoView(request, false), auth.key.mode === 'test');
};

export const onRequestDelete: PagesFunction<Env, 'id'> = async ({ request, env, params }) => {
  const auth = await requireApiKey(request, env, 'video');
  if (!auth.ok) return auth.response;
  return removeCover(env, auth.userId, idOf(params.id), videoView(request, false), auth.key.mode === 'test');
};

export const onRequest: PagesFunction<Env, 'id'> = async () => methodNotAllowed('PUT, DELETE');
