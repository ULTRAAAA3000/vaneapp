/**
 * Public API: finish an upload.   POST /api/v1/video/uploads/:id/complete   → { ok, video } (a test key accepts and ignores it)
 * Checks and answers: see lib/videoupload.ts (completeUpload).
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../../../../types';
import { requireApiKey } from '../../../../lib/apikeys';
import { json, methodNotAllowed } from '../../../../lib/http';
import { completeUpload } from '../../../../lib/videoupload';
import { videoView } from '../../../../lib/videos';

const idOf = (p: string | string[] | undefined) => (Array.isArray(p) ? p[0] : p) ?? '';

export const onRequestPost: PagesFunction<Env, 'id'> = async ({ request, env, params }) => {
  const auth = await requireApiKey(request, env, 'video');
  if (!auth.ok) return auth.response;
  if (auth.key.mode === 'test') return json({ ok: true, simulated: true });
  return completeUpload(env, auth.userId, idOf(params.id), videoView(request, false));
};

export const onRequest: PagesFunction<Env, 'id'> = async () => methodNotAllowed('POST');
