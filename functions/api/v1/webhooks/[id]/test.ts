/** POST /api/v1/webhooks/:id/test → sends a signed `ping` to the webhook now and reports the answer (works with any key type). */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../../../types';
import { requireApiKey } from '../../../lib/apikeys';
import { methodNotAllowed } from '../../../lib/http';
import { pingWebhookForUser } from '../../../lib/webhookapi';

export const onRequestPost: PagesFunction<Env, 'id'> = async ({ request, env, params }) => {
  const auth = await requireApiKey(request, env, 'post');
  if (!auth.ok) return auth.response;
  return pingWebhookForUser(env, auth.userId, Array.isArray(params.id) ? params.id[0] : params.id);
};

export const onRequest: PagesFunction<Env, 'id'> = async () => methodNotAllowed('POST');
