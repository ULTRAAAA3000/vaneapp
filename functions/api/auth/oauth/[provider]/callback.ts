/** GET /api/auth/oauth/:provider/callback — the provider sends the person back here with ?code&state */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../../../types';
import { fail, methodNotAllowed } from '../../../lib/http';
import { fetchIdentity, isProvider, oauthProviders, signInWith } from '../../../lib/oauthlogin';
import { callbackUrl, clearedStateCookie, loginRedirect, readState, successUrl } from '../../../lib/oauthflow';
import { logAttempt } from '../../../lib/attempts';

export const onRequestGet: PagesFunction<Env, 'provider'> = async ({ request, env, params }) => {
  const p = params.provider;
  if (!isProvider(p) || !oauthProviders(env)[p]) return fail(404, 'Not found');
  const url = new URL(request.url);
  const saved = readState(request);
  const code = url.searchParams.get('code') ?? '';
  const state = url.searchParams.get('state') ?? '';
  const done = (res: Response): Response => { res.headers.append('Set-Cookie', clearedStateCookie(request)); return res; };

  if (url.searchParams.get('error')) return done(loginRedirect(request, 'cancelled'));
  if (!saved || saved.p !== p || !code || code.length > 2048 || state.length < 20 || state !== saved.state) {
    await logAttempt(env, request, { kind: 'login', ok: false, reason: 'oauth_state' });
    return done(loginRedirect(request, 'expired'));
  }
  const id = await fetchIdentity(p, env, callbackUrl(request, p), code, saved.verifier);
  if (!id) return done(loginRedirect(request, 'failed'));
  const r = await signInWith(env, request, p, id);
  if (!r.ok) return done(loginRedirect(request, r.code));
  const res = new Response(null, { status: 302, headers: { Location: successUrl(request, saved.product, saved.next), 'Cache-Control': 'no-store' } });
  res.headers.append('Set-Cookie', r.cookie);
  return done(res);
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET');
