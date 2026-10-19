/** The video library.   GET /api/video/videos   → { ok, videos: VideoPublic[] }, newest first (unfinished uploads included). */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../../types';
import { requireUser } from '../../lib/auth';
import { methodNotAllowed } from '../../lib/http';
import { listVideosForUser, videoView } from '../../lib/videos';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  return listVideosForUser(env, auth.userId, videoView(request, true));
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET');
