/** Disconnect a video channel.   DELETE /api/video/channels/:id   (see ../../lib/videochannels.ts) */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../../types';
import { requireUser } from '../../lib/auth';
import { methodNotAllowed } from '../../lib/http';
import { removeVideoChannel } from '../../lib/videochannels';

const idOf = (p: string | string[] | undefined) => (Array.isArray(p) ? p[0] : p) ?? '';

export const onRequestDelete: PagesFunction<Env, 'id'> = async ({ request, env, params }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  return removeVideoChannel(env, auth.userId, idOf(params.id));
};

export const onRequest: PagesFunction<Env, 'id'> = async () => methodNotAllowed('DELETE');
