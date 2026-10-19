/** Connect a video channel.   POST /api/video/channels/connect  { platform }   (409 platform_unavailable until the network is open; see ../../lib/videochannels.ts) */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../../types';
import { requireUser } from '../../lib/auth';
import { methodNotAllowed, readJson } from '../../lib/http';
import { connectVideoChannel } from '../../lib/videochannels';

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  const parsed = await readJson(request, 4096);
  if (!parsed.ok) return parsed.response;
  return connectVideoChannel(env, auth.userId, parsed.data);
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('POST');
