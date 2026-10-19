/**
 * Announce a video in the user's social channels.   POST /api/video/videos/:id/announce
 *
 *   { "text": "New video!\n\n{link}", "channelIds": ["<uuid>", …] }
 *
 * "{link}" becomes the video's public link. The post is made by the same code as a post in Vane Post, so the same limits
 * apply (Bluesky 300, Mastodon 500, X 280, …) and a text that is too long for a chosen network is refused with the reason.
 * → 201 { ok, groupId, channels, text, url, scheduledAt }
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../../../types';
import { requireUser } from '../../../lib/auth';
import { methodNotAllowed, readJson } from '../../../lib/http';
import { announceVideo } from '../../../lib/videoannounce';
import { videoView } from '../../../lib/videos';

const idOf = (p: string | string[] | undefined) => (Array.isArray(p) ? p[0] : p) ?? '';

export const onRequestPost: PagesFunction<Env, 'id'> = async ({ request, env, params }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  const parsed = await readJson(request, 32_768);
  if (!parsed.ok) return parsed.response;
  return announceVideo(env, auth.userId, idOf(params.id), parsed.data, videoView(request, true));
};

export const onRequest: PagesFunction<Env, 'id'> = async () => methodNotAllowed('POST');
