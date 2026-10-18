/**
 * One upload.
 *
 *   GET    /api/video/uploads/:id   where it stands: which chunks are already stored (how a broken upload resumes)
 *   DELETE /api/video/uploads/:id   cancel it: the stored chunks and the row are thrown away
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../../types';
import { requireUser } from '../../lib/auth';
import { methodNotAllowed } from '../../lib/http';
import { cancelUpload, uploadStatus } from '../../lib/videoupload';
import { VIDEO_FILE_BASE } from '../../lib/videos';

const idOf = (p: string | string[] | undefined) => (Array.isArray(p) ? p[0] : p) ?? '';

export const onRequestGet: PagesFunction<Env, 'id'> = async ({ request, env, params }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  return uploadStatus(env, auth.userId, idOf(params.id), VIDEO_FILE_BASE);
};

export const onRequestDelete: PagesFunction<Env, 'id'> = async ({ request, env, params }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  return cancelUpload(env, auth.userId, idOf(params.id));
};

export const onRequest: PagesFunction<Env, 'id'> = async () => methodNotAllowed('GET, DELETE');
