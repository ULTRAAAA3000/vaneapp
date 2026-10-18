/** The video library.   GET /api/video/videos   → { ok, videos: VideoPublic[] }, newest first (unfinished uploads included). */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../../types';
import { requireUser } from '../../lib/auth';
import { methodNotAllowed } from '../../lib/http';
import { listVideosForUser, VIDEO_FILE_BASE } from '../../lib/videos';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  return listVideosForUser(env, auth.userId, VIDEO_FILE_BASE);
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET');
