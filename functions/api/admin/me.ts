/**
 * GET /api/admin/me
 *   signed in    → { ok: true, signedIn: true, email, features: { turnstile, gsc, vpnApi } }
 *   not signed in→ { ok: true, signedIn: false, configured, turnstileSiteKey }   (so the login form can render)
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { adminConfigured, requireAdmin } from '../lib/admin';
import { readServiceAccount } from '../lib/google';
import { json, methodNotAllowed } from '../lib/http';
import { turnstileEnabled } from '../lib/turnstile';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) {
    return json({
      ok: true,
      signedIn: false,
      configured: adminConfigured(env),
      turnstileSiteKey: turnstileEnabled(env) ? (env.TURNSTILE_SITE_KEY as string) : null,
    });
  }
  return json({
    ok: true,
    signedIn: true,
    email: env.ADMIN_EMAIL ?? '',
    features: { turnstile: turnstileEnabled(env), gsc: Boolean(readServiceAccount(env)), vpnApi: Boolean(env.PROXYCHECK_KEY), ipAllowList: Boolean(env.ADMIN_ALLOW_IPS) },
  });
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET');
