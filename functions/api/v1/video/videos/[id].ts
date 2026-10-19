/**
 * Public API: one video.
 *
 *   GET    /api/v1/video/videos/:id   → { ok, video }
 *   PATCH  /api/v1/video/videos/:id   { title?, description?, tags? }   (a test key only checks, and changes nothing)
 *   DELETE /api/v1/video/videos/:id   the file and its row are removed (a test key only checks, and changes nothing)
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../../../types';
import { requireApiKey } from '../../../lib/apikeys';
import { methodNotAllowed, readJson } from '../../../lib/http';
import { deleteVideoForUser, getVideoForUser, updateVideoForUser, videoView } from '../../../lib/videos';

const idOf = (p: string | string[] | undefined) => (Array.isArray(p) ? p[0] : p) ?? '';

export const onRequestGet: PagesFunction<Env, 'id'> = async ({ request, env, params }) => {
  const auth = await requireApiKey(request, env, 'video');
  if (!auth.ok) return auth.response;
  return getVideoForUser(env, auth.userId, idOf(params.id), videoView(request, false));
};

export const onRequestPatch: PagesFunction<Env, 'id'> = async ({ request, env, params }) => {
  const auth = await requireApiKey(request, env, 'video');
  if (!auth.ok) return auth.response;
  const parsed = await readJson(request, 16_384);
  if (!parsed.ok) return parsed.response;
  return updateVideoForUser(env, auth.userId, idOf(params.id), parsed.data, videoView(request, false), auth.key.mode === 'test');
};

export const onRequestDelete: PagesFunction<Env, 'id'> = async ({ request, env, params }) => {
  const auth = await requireApiKey(request, env, 'video');
  if (!auth.ok) return auth.response;
  return deleteVideoForUser(env, auth.userId, idOf(params.id), auth.key.mode === 'test');
};

export const onRequest: PagesFunction<Env, 'id'> = async () => methodNotAllowed('GET, PATCH, DELETE');
