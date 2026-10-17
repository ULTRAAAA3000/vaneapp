/**
 * Public API: one post.
 *
 *   GET    /api/v1/posts/:id   its status (scheduled → processing → sent | failed | cancelled): what to poll after scheduling
 *   DELETE /api/v1/posts/:id   cancel it while it is still "scheduled" (a test key only checks, and changes nothing)
 *
 * Cancelling does not give the quota unit back: the quota is used when a post is accepted.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../../types';
import { requireApiKey } from '../../lib/apikeys';
import { methodNotAllowed } from '../../lib/http';
import { cancelPostForUser } from '../../posts/cancel';
import { getPostForUser } from '../../posts/list';

const idOf = (p: string | string[] | undefined) => (Array.isArray(p) ? p[0] : p) ?? '';

export const onRequestGet: PagesFunction<Env, 'id'> = async ({ request, env, params }) => {
  const auth = await requireApiKey(request, env, 'post');
  if (!auth.ok) return auth.response;
  return getPostForUser(env, auth.userId, idOf(params.id));
};

export const onRequestDelete: PagesFunction<Env, 'id'> = async ({ request, env, params }) => {
  const auth = await requireApiKey(request, env, 'post');
  if (!auth.ok) return auth.response;
  return cancelPostForUser(env, auth.userId, idOf(params.id), auth.key.mode === 'test');
};

export const onRequest: PagesFunction<Env, 'id'> = async () => methodNotAllowed('GET, DELETE');
