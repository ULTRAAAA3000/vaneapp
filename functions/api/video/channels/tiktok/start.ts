/**
 * GET /api/video/channels/tiktok/start → 302 to TikTok's consent screen (profile + video publish only).
 * Must be opened on the main site (the Studio button points there): the callback is one fixed address and the session cookie covers both hosts.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../../../types';
import { requireUser } from '../../../lib/auth';
import { toB64Url } from '../../../lib/encoding';
import { methodNotAllowed } from '../../../lib/http';
import { requireVideoAccess } from '../../../lib/videoplans';
import { bump, clientIp, retryAfter } from '../../../lib/throttle';
import { tiktokAuthorizeUrl, tiktokConfigured } from '../../../lib/tiktok';
import { backToStudio, netCallback, ytStateCookie } from '../../../lib/youtubeconnect';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return backToStudio(request, 'connect_error=signin');
  if (!tiktokConfigured(env)) return backToStudio(request, 'connect_error=unavailable');
  if (await requireVideoAccess(env, auth.userId)) return backToStudio(request, 'connect_error=plan');
  const key = `ttconnect:${clientIp(request)}`;
  if (await retryAfter(env, key, 20)) return backToStudio(request, 'connect_error=busy');
  await bump(env, key, 600);

  const state = toB64Url(crypto.getRandomValues(new Uint8Array(24)));
  const verifier = toB64Url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = toB64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  return new Response(null, {
    status: 302,
    headers: { Location: tiktokAuthorizeUrl(env, netCallback(request, 'tiktok'), state), 'Set-Cookie': ytStateCookie(request, { state, verifier, uid: auth.userId }, 'tiktok'), 'Cache-Control': 'no-store' },
  });
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET');
