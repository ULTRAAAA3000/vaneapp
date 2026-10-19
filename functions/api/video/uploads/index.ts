/**
 * Start a video upload.   POST /api/video/uploads
 *
 *   { "size": 52428800, "contentType": "video/mp4", "fileName": "My trip.mp4",   // size and contentType are required
 *     "title": "…", "description": "…", "tags": ["travel"] }                      // optional (the title defaults to the file name)
 *
 *   → 201 { ok, videoId, partSize, partCount, uploadedParts: [], expiresAt, video }
 *
 * Then send every chunk (PUT /api/video/uploads/:id/parts/:n) and finish (POST /api/video/uploads/:id/complete).
 * The whole flow is described in ../../lib/videoupload.ts.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../../types';
import { requireUser } from '../../lib/auth';
import { methodNotAllowed, readJson } from '../../lib/http';
import { startUpload, validateStart } from '../../lib/videoupload';
import { videoView } from '../../lib/videos';

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;

  const parsed = await readJson(request, 8192);
  if (!parsed.ok) return parsed.response;
  const checked = validateStart(parsed.data);
  if (!checked.ok) return checked.response;

  return startUpload(env, auth.userId, checked.v, 'ui', videoView(request, true));
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('POST');
