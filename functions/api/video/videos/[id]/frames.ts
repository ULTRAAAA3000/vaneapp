/**
 * The frames a video is checked by (the browser takes them from the file after it is uploaded).
 *
 *   POST /api/video/videos/:id/frames   multipart/form-data, 3 to 8 JPEGs in fields named "frame"  → { ok, frames, video }
 *
 * Every frame is judged on its own; one flagged frame removes the video. Without a passed check a video cannot be published or
 * get a public link (see ../../../lib/videocheck.ts).
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../../../types';
import { requireUser } from '../../../lib/auth';
import { methodNotAllowed } from '../../../lib/http';
import { putFrames } from '../../../lib/videocheck';
import { videoView } from '../../../lib/videos';

const idOf = (p: string | string[] | undefined) => (Array.isArray(p) ? p[0] : p) ?? '';

export const onRequestPost: PagesFunction<Env, 'id'> = async ({ request, env, params }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  return putFrames(env, auth.userId, idOf(params.id), request, videoView(request, true));
};

export const onRequest: PagesFunction<Env, 'id'> = async () => methodNotAllowed('POST');
