/**
 * Public API: send one chunk.   PUT /api/v1/video/uploads/:id/parts/:n     body = the raw bytes of chunk n (1-based)
 * (a test key accepts and ignores it). Rules and answers: see the dashboard's twin in video/uploads/[id]/parts/[n].ts.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../../../../../types';
import { requireApiKey } from '../../../../../lib/apikeys';
import { json, methodNotAllowed } from '../../../../../lib/http';
import { putPart } from '../../../../../lib/videoupload';

const one = (p: string | string[] | undefined) => (Array.isArray(p) ? p[0] : p) ?? '';

export const onRequestPut: PagesFunction<Env, 'id' | 'n'> = async ({ request, env, params }) => {
  const auth = await requireApiKey(request, env, 'video');
  if (!auth.ok) return auth.response;
  if (auth.key.mode === 'test') return json({ ok: true, simulated: true, partNumber: Number(one(params.n)) || null });
  return putPart(env, auth.userId, one(params.id), one(params.n), request);
};

export const onRequest: PagesFunction<Env, 'id' | 'n'> = async () => methodNotAllowed('PUT');
