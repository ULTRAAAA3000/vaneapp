/** DELETE /api/v1/webhooks/:id → remove a webhook (a test key only checks it exists). The "unsubscribe" call of REST-hook tools. */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../../types';
import { requireApiKey } from '../../lib/apikeys';
import { methodNotAllowed } from '../../lib/http';
import { deleteWebhookForUser } from '../../lib/webhookapi';

export const onRequestDelete: PagesFunction<Env, 'id'> = async ({ request, env, params }) => {
  const auth = await requireApiKey(request, env, 'post');
  if (!auth.ok) return auth.response;
  return deleteWebhookForUser(env, auth.userId, Array.isArray(params.id) ? params.id[0] : params.id, auth.key.mode === 'test');
};

export const onRequest: PagesFunction<Env, 'id'> = async () => methodNotAllowed('DELETE');
