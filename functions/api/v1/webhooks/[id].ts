/** DELETE /api/v1/webhooks/:id → stop a subscription (REST hooks "unsubscribe"). A test key checks and changes nothing. */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../../types';
import { requireApiKey } from '../../lib/apikeys';
import { fail, json, methodNotAllowed, UUID_RE } from '../../lib/http';

export const onRequestDelete: PagesFunction<Env> = async ({ request, env, params }) => {
  const auth = await requireApiKey(request, env, 'post');
  if (!auth.ok) return auth.response;
  const id = String(params.id ?? '');
  if (!UUID_RE.test(id)) return fail(404, 'Webhook not found');
  if (auth.key.mode === 'test') return json({ ok: true, test: true }, 200, { 'X-Vane-Mode': 'test' });
  try {
    const res = await env.DB.prepare('DELETE FROM webhook_subscriptions WHERE id = ?1 AND user_id = ?2').bind(id, auth.userId).run();
    if (!res.meta.changes) return fail(404, 'Webhook not found');
  } catch {
    return fail(503, 'Webhooks are not enabled on this server yet. The database needs the two webhook tables from schema.sql.');
  }
  return json({ ok: true });
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('DELETE');
