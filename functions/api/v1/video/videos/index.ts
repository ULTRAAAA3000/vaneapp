/** Public API: the video library.   GET /api/v1/video/videos   → { ok, videos: VideoPublic[] }, newest first. */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../../../types';
import { requireApiKey } from '../../../lib/apikeys';
import { methodNotAllowed } from '../../../lib/http';
import { listVideosForUser, videoView } from '../../../lib/videos';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireApiKey(request, env, 'video');
  if (!auth.ok) return auth.response;
  return listVideosForUser(env, auth.userId, videoView(request, false));
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET');
