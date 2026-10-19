/**
 * Finish an upload.   POST /api/video/uploads/:id/complete
 *
 * R2 assembles the chunks into the file, the file is checked (declared size, a real MP4/MOV with its `moov` index),
 * and the video becomes 'ready'.   → 200 { ok, video }   ·   409 missing_parts { missing: [...] }   ·   422 invalid_video
 * Calling it again for a finished video just returns the video.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../../../types';
import { requireUser } from '../../../lib/auth';
import { methodNotAllowed } from '../../../lib/http';
import { completeUpload } from '../../../lib/videoupload';
import { videoView } from '../../../lib/videos';

const idOf = (p: string | string[] | undefined) => (Array.isArray(p) ? p[0] : p) ?? '';

export const onRequestPost: PagesFunction<Env, 'id'> = async ({ request, env, params }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  return completeUpload(env, auth.userId, idOf(params.id), videoView(request, true));
};

export const onRequest: PagesFunction<Env, 'id'> = async () => methodNotAllowed('POST');
