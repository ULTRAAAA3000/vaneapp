/** Try a failed publication again from the start.   POST /api/video/publications/:id/retry   (409 not_failed otherwise). See ../../../lib/videopublish.ts. */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../../../types';
import { requireUser } from '../../../lib/auth';
import { methodNotAllowed } from '../../../lib/http';
import { retryPublication } from '../../../lib/videopublish';

const idOf = (p: string | string[] | undefined) => (Array.isArray(p) ? p[0] : p) ?? '';

export const onRequestPost: PagesFunction<Env, 'id'> = async ({ request, env, params, waitUntil }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  return retryPublication(env, auth.userId, idOf(params.id), waitUntil);
};

export const onRequest: PagesFunction<Env, 'id'> = async () => methodNotAllowed('POST');
