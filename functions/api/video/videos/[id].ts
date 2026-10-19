/**
 * One video in the library.
 *
 *   GET    /api/video/videos/:id   → { ok, video }
 *   PATCH  /api/video/videos/:id   { title?, description?, tags? } → { ok, video }
 *   DELETE /api/video/videos/:id   the file and its row are removed for good
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../../types';
import { requireUser } from '../../lib/auth';
import { methodNotAllowed, readJson } from '../../lib/http';
import { deleteVideoForUser, getVideoForUser, updateVideoForUser, videoView } from '../../lib/videos';

const idOf = (p: string | string[] | undefined) => (Array.isArray(p) ? p[0] : p) ?? '';

export const onRequestGet: PagesFunction<Env, 'id'> = async ({ request, env, params }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  return getVideoForUser(env, auth.userId, idOf(params.id), videoView(request, true));
};

export const onRequestPatch: PagesFunction<Env, 'id'> = async ({ request, env, params }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  const parsed = await readJson(request, 16_384);
  if (!parsed.ok) return parsed.response;
  return updateVideoForUser(env, auth.userId, idOf(params.id), parsed.data, videoView(request, true));
};

export const onRequestDelete: PagesFunction<Env, 'id'> = async ({ request, env, params }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  return deleteVideoForUser(env, auth.userId, idOf(params.id));
};

export const onRequest: PagesFunction<Env, 'id'> = async () => methodNotAllowed('GET, PATCH, DELETE');
