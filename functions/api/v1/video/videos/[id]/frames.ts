/**
 * Public API: the frames a video is checked by.
 *
 *   POST /api/v1/video/videos/:id/frames   multipart/form-data, 3 to 8 JPEGs in fields named "frame"  → { ok, frames, video }
 *
 * Take the frames from different places of the video (one every ~6 seconds, at most 8). Every frame is judged on its own and
 * one flagged frame removes the video. A video cannot be published or get a public link until its frames passed.
 * A test key judges the frames and stores nothing.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../../../../types';
import { requireApiKey } from '../../../../lib/apikeys';
import { methodNotAllowed } from '../../../../lib/http';
import { putFrames } from '../../../../lib/videocheck';
import { videoView } from '../../../../lib/videos';

const idOf = (p: string | string[] | undefined) => (Array.isArray(p) ? p[0] : p) ?? '';

export const onRequestPost: PagesFunction<Env, 'id'> = async ({ request, env, params }) => {
  const auth = await requireApiKey(request, env, 'video');
  if (!auth.ok) return auth.response;
  return putFrames(env, auth.userId, idOf(params.id), request, videoView(request, false), auth.key.mode === 'test');
};

export const onRequest: PagesFunction<Env, 'id'> = async () => methodNotAllowed('POST');
