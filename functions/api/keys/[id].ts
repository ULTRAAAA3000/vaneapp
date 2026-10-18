/** DELETE /api/keys/:id → revoke one of my keys. Requests that use it stop working immediately. */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { requireUser } from '../lib/auth';
import { fail, json, methodNotAllowed, UUID_RE } from '../lib/http';

export const onRequestDelete: PagesFunction<Env, 'id'> = async ({ request, env, params }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;

  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  if (!id || !UUID_RE.test(id)) return fail(404, 'Key not found');

  // Soft delete: the row stays for the audit trail (usage_logs point at it), the key stops authenticating.
  const res = await env.DB
    .prepare('UPDATE api_keys SET revoked_at = ?3 WHERE id = ?1 AND user_id = ?2 AND revoked_at IS NULL')
    .bind(id, auth.userId, Math.floor(Date.now() / 1000))
    .run();
  if ((res.meta?.changes ?? 0) === 0) return fail(404, 'Key not found');
  return json({ ok: true });
};

export const onRequest: PagesFunction<Env, 'id'> = async () => methodNotAllowed('DELETE');
