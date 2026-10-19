/** My video channels and the networks Vane Studio can publish to.   GET /api/video/channels   (see ../lib/videochannels.ts) */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { requireUser } from '../lib/auth';
import { methodNotAllowed } from '../lib/http';
import { listVideoChannels } from '../lib/videochannels';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  return listVideoChannels(env, auth.userId);
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET');
