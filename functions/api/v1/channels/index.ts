/** GET /api/v1/channels → my channels (their ids are what `channelIds` in POST /api/v1/posts expects). */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../../types';
import { channelsForUser } from '../../channels/index';
import { requireApiKey } from '../../lib/apikeys';
import { json, methodNotAllowed } from '../../lib/http';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireApiKey(request, env, 'post');
  if (!auth.ok) return auth.response;
  return json({ ok: true, channels: await channelsForUser(env, auth.userId) });
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET');
