/**
 * Cancel a queued publication, or remove a finished one from the history.   DELETE /api/video/publications/:id
 * (409 in_progress while it is being published right now.) See ../../lib/videopublish.ts.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../../types';
import { requireUser } from '../../lib/auth';
import { methodNotAllowed } from '../../lib/http';
import { removePublication } from '../../lib/videopublish';

const idOf = (p: string | string[] | undefined) => (Array.isArray(p) ? p[0] : p) ?? '';

export const onRequestDelete: PagesFunction<Env, 'id'> = async ({ request, env, params }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  return removePublication(env, auth.userId, idOf(params.id));
};

export const onRequest: PagesFunction<Env, 'id'> = async () => methodNotAllowed('DELETE');
