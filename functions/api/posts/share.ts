import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { requireUser } from '../lib/auth';
import { fail, isRecord, methodNotAllowed, readJson } from '../lib/http';
import { listShares, sharePost, stopSharing } from '../lib/postpreview';

export const onRequest: PagesFunction<Env> = async ({ env, request }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  if (request.method === 'GET') return listShares(env, request, auth.userId);
  if (request.method === 'POST') {
    const body = await readJson(request);
    if (!body.ok) return body.response;
    if (!isRecord(body.data)) return fail(400, 'Invalid request.');
    return sharePost(env, request, auth.userId, body.data.groupId);
  }
  if (request.method === 'DELETE') return stopSharing(env, auth.userId, new URL(request.url).searchParams.get('groupId'));
  return methodNotAllowed('GET, POST, DELETE');
};
