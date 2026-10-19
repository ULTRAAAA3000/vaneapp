/** DELETE /api/webhooks/:id → remove one of my webhooks (its queued deliveries go with it). */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { requireUser } from '../lib/auth';
import { methodNotAllowed } from '../lib/http';
import { deleteWebhookForUser } from '../lib/webhookapi';

export const onRequestDelete: PagesFunction<Env, 'id'> = async ({ request, env, params }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  return deleteWebhookForUser(env, auth.userId, Array.isArray(params.id) ? params.id[0] : params.id);
};

export const onRequest: PagesFunction<Env, 'id'> = async () => methodNotAllowed('DELETE');
