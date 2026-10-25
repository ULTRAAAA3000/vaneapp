/**
 * GET /api/auth/oauth/github/start?product=post|studio&next=/checkout?plan=pro
 * GET /api/auth/oauth/google/start
 *   → 302 to the provider. The callback always lives on the main site (a provider accepts one fixed address), so the buttons point there.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../../../types';
import { toB64Url } from '../../../lib/encoding';
import { fail, methodNotAllowed } from '../../../lib/http';
import { authorizeUrl, isProvider, oauthProviders } from '../../../lib/oauthlogin';
import { callbackUrl, loginRedirect, stateCookie } from '../../../lib/oauthflow';
import { bump, clientIp, retryAfter } from '../../../lib/throttle';
import { guard } from '../../../lib/guard';

export const onRequestGet: PagesFunction<Env, 'provider'> = async ({ request, env, params }) => {
  const p = params.provider;
  if (!isProvider(p) || !oauthProviders(env)[p]) return fail(404, 'Not found');
  const blocked = await guard(env, request, 'login', 'login');
  if (blocked) return blocked;
  const key = `oauth:${clientIp(request)}`;
  if (await retryAfter(env, key, 30)) return loginRedirect(request, 'busy');
  await bump(env, key, 600);

  const url = new URL(request.url);
  const product = url.searchParams.get('product') === 'studio' ? 'studio' : 'post';
  const next = /^\/checkout(\?[A-Za-z0-9=&%._-]*)?$/.test(url.searchParams.get('next') ?? '') ? url.searchParams.get('next')! : '';

  const state = toB64Url(crypto.getRandomValues(new Uint8Array(24)));
  const verifier = toB64Url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = toB64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const target = authorizeUrl(p, env, callbackUrl(request, p), state, challenge);
  return new Response(null, { status: 302, headers: { Location: target, 'Set-Cookie': stateCookie(request, JSON.stringify({ p, state, verifier, product, next })), 'Cache-Control': 'no-store' } });
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET');
