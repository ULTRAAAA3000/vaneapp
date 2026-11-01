/** GET /api/auth/me → the signed-in user + which optional features this deployment has */
import { redditConfigured } from '../channels/reddit';
import { facebookConfigured } from '../channels/facebook';
import { pinterestConfigured } from '../channels/pinterest';
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env, UserPublic } from '../../../types';
import { requireUser } from '../lib/auth';
import { linkedinConfigured } from '../channels/linkedin';
import { quickConnectAvailable, systemBotHandle } from '../channels/quick';
import { threadsConfigured } from '../channels/threads';
import { fail, json, methodNotAllowed } from '../lib/http';
import { pausedNetworks } from '../lib/networks';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;

  const user = await env.DB
    .prepare('SELECT id, email, name, timezone FROM users WHERE id = ?1')
    .bind(auth.userId)
    .first<UserPublic>();
  if (!user) return fail(401, 'Authentication required');

  const quick = quickConnectAvailable(env);
  return json({
    ok: true,
    user,
    features: { uploads: Boolean(env.MEDIA), quickConnect: quick, systemBot: quick ? systemBotHandle(env) : null, linkedin: linkedinConfigured(env), threads: threadsConfigured(env), reddit: redditConfigured(env), facebook: facebookConfigured(env), pinterest: pinterestConfigured(env), pausedNetworks: await pausedNetworks(env) },
  });
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET');
