/**
 * Public API: one upload.
 *
 *   GET    /api/v1/video/uploads/:id   which chunks are stored (how a broken upload resumes)
 *   DELETE /api/v1/video/uploads/:id   cancel it (a test key changes nothing)
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../../../types';
import { requireApiKey } from '../../../lib/apikeys';
import { json, methodNotAllowed } from '../../../lib/http';
import { cancelUpload, uploadStatus } from '../../../lib/videoupload';
import { videoView } from '../../../lib/videos';

const idOf = (p: string | string[] | undefined) => (Array.isArray(p) ? p[0] : p) ?? '';

export const onRequestGet: PagesFunction<Env, 'id'> = async ({ request, env, params }) => {
  const auth = await requireApiKey(request, env, 'video');
  if (!auth.ok) return auth.response;
  return uploadStatus(env, auth.userId, idOf(params.id), videoView(request, false));
};

export const onRequestDelete: PagesFunction<Env, 'id'> = async ({ request, env, params }) => {
  const auth = await requireApiKey(request, env, 'video');
  if (!auth.ok) return auth.response;
  return auth.key.mode === 'test' ? json({ ok: true, simulated: true }) : cancelUpload(env, auth.userId, idOf(params.id));
};

export const onRequest: PagesFunction<Env, 'id'> = async () => methodNotAllowed('GET, DELETE');
