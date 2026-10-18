/**
 * Send one chunk.   PUT /api/video/uploads/:id/parts/:n     body = the raw bytes of chunk n (1-based)
 *
 * Every chunk but the last is exactly `partSize` bytes (the start call says how many); the last is what is left.
 * Chunks can go in any order and any number at a time; sending one again replaces it.   → { ok, partNumber, size }
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../../../../types';
import { requireUser } from '../../../../lib/auth';
import { methodNotAllowed } from '../../../../lib/http';
import { putPart } from '../../../../lib/videoupload';

const one = (p: string | string[] | undefined) => (Array.isArray(p) ? p[0] : p) ?? '';

export const onRequestPut: PagesFunction<Env, 'id' | 'n'> = async ({ request, env, params }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  return putPart(env, auth.userId, one(params.id), one(params.n), request);
};

export const onRequest: PagesFunction<Env, 'id' | 'n'> = async () => methodNotAllowed('PUT');
