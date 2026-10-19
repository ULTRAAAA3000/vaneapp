/**
 * Public API: start a video upload.   POST /api/v1/video/uploads
 *
 * Same body and answer as the dashboard's POST /api/video/uploads (see lib/videoupload.ts for the whole chunked flow).
 * A test key (cvid_test_…) gets the real answer's shape with nothing stored and nothing counted: its chunk and
 * complete calls are accepted and ignored.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../../../types';
import { requireApiKey } from '../../../lib/apikeys';
import { methodNotAllowed, readJson } from '../../../lib/http';
import { simulateStart, startUpload, validateStart } from '../../../lib/videoupload';
import { videoView } from '../../../lib/videos';

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireApiKey(request, env, 'video');
  if (!auth.ok) return auth.response;

  const parsed = await readJson(request, 8192);
  if (!parsed.ok) return parsed.response;
  const checked = validateStart(parsed.data);
  if (!checked.ok) return checked.response;

  return auth.key.mode === 'test' ? simulateStart(checked.v) : startUpload(env, auth.userId, checked.v, 'api', videoView(request, false));
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('POST');
