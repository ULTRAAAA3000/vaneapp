/**
 * Publish a video to one or more of the user's video channels.   POST /api/video/videos/:id/publish
 *
 *   { "channelIds": ["<uuid>", …], "title": "…", "description": "…", "privacy": "private" | "unlisted" | "public" }
 *   (title and description default to the library entry's, privacy to "private")
 *
 * → 201 { ok, publications: [ … one per channel, queued … ] }. They are picked up at once and followed in
 * GET /api/video/publications. See ../../lib/videopublish.ts.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../../../types';
import { requireUser } from '../../../lib/auth';
import { methodNotAllowed, readJson } from '../../../lib/http';
import { publishVideo } from '../../../lib/videopublish';

const idOf = (p: string | string[] | undefined) => (Array.isArray(p) ? p[0] : p) ?? '';

export const onRequestPost: PagesFunction<Env, 'id'> = async ({ request, env, params, waitUntil }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  const parsed = await readJson(request, 32_768);
  if (!parsed.ok) return parsed.response;
  return publishVideo(env, auth.userId, idOf(params.id), parsed.data, waitUntil);
};

export const onRequest: PagesFunction<Env, 'id'> = async () => methodNotAllowed('POST');
