/**
 * A video's public link: an unguessable address anyone can open to watch or download the video.
 *
 *   POST   /api/video/videos/:id/link   make it (or get the existing one)  → 201 { ok, url, video }
 *   DELETE /api/video/videos/:id/link   remove it: the address stops working at once
 *
 * The address is  <studio host>/api/video/public/<token>  (see ../../public/[token].ts).
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../../../types';
import { requireUser } from '../../../lib/auth';
import { methodNotAllowed } from '../../../lib/http';
import { createLink, removeLink } from '../../../lib/videoextras';
import { videoView } from '../../../lib/videos';

const idOf = (p: string | string[] | undefined) => (Array.isArray(p) ? p[0] : p) ?? '';

export const onRequestPost: PagesFunction<Env, 'id'> = async ({ request, env, params }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  return createLink(env, auth.userId, idOf(params.id), videoView(request, true));
};

export const onRequestDelete: PagesFunction<Env, 'id'> = async ({ request, env, params }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  return removeLink(env, auth.userId, idOf(params.id), videoView(request, true));
};

export const onRequest: PagesFunction<Env, 'id'> = async () => methodNotAllowed('POST, DELETE');
