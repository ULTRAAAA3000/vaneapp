/**
 * The publishing history.   GET /api/video/publications[?videoId=<uuid>]   → { ok, publications: [ … newest first, up to 100 … ] }
 * Each one: status (queued / publishing / published / failed), attempts, when the next try is due, the error, the link on the network.
 * The dashboard polls this while something is going on. See ../lib/videopublish.ts.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { requireUser } from '../lib/auth';
import { methodNotAllowed } from '../lib/http';
import { listPublications } from '../lib/videopublish';

export const onRequestGet: PagesFunction<Env> = async ({ request, env, waitUntil }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  return listPublications(env, auth.userId, new URL(request.url).searchParams.get('videoId'), waitUntil);
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET');
