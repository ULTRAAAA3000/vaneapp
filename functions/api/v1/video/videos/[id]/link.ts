/**
 * Public API: a video's public link.
 *
 *   POST   /api/v1/video/videos/:id/link   make it (or get the existing one)  → 201 { ok, url, video }
 *   DELETE /api/v1/video/videos/:id/link   remove it
 *
 * A test key (cvid_test_…) gets the shape of the answer with nothing created. The address works on its own, no key needed
 * to open it: that is what lets TikTok, Instagram and other services pull the file.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../../../../types';
import { requireApiKey } from '../../../../lib/apikeys';
import { methodNotAllowed } from '../../../../lib/http';
import { createLink, removeLink } from '../../../../lib/videoextras';
import { videoView } from '../../../../lib/videos';

const idOf = (p: string | string[] | undefined) => (Array.isArray(p) ? p[0] : p) ?? '';

export const onRequestPost: PagesFunction<Env, 'id'> = async ({ request, env, params }) => {
  const auth = await requireApiKey(request, env, 'video');
  if (!auth.ok) return auth.response;
  return createLink(env, auth.userId, idOf(params.id), videoView(request, false), auth.key.mode === 'test');
};

export const onRequestDelete: PagesFunction<Env, 'id'> = async ({ request, env, params }) => {
  const auth = await requireApiKey(request, env, 'video');
  if (!auth.ok) return auth.response;
  return removeLink(env, auth.userId, idOf(params.id), videoView(request, false), auth.key.mode === 'test');
};

export const onRequest: PagesFunction<Env, 'id'> = async () => methodNotAllowed('POST, DELETE');
