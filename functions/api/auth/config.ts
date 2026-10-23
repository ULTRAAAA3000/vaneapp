/**
 * GET /api/auth/config  (public)
 *   { ok, turnstileSiteKey: string | null, turnstile: { enabled, siteKeySet, secretKeySet },
 *     email: { enabled, apiKeySet, fromSet }, oauth: { github, google } }
 * Lets /login render the human check. The status booleans make a half-configured deploy easy to
 * diagnose (open this URL): they say WHICH key the function cannot see, never the values.
 * `email.enabled: false` means sign-up creates the account at once and no code is ever mailed.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { json, methodNotAllowed } from '../lib/http';
import { emailConfigured, emailStatus } from '../lib/mail';
import { oauthProviders } from '../lib/oauthlogin';
import { turnstileStatus, warnIfHalfConfigured } from '../lib/turnstile';

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  warnIfHalfConfigured(env);
  emailConfigured(env); // logs a warning when only one of the two email settings is visible
  const status = turnstileStatus(env);
  return json({ ok: true, turnstileSiteKey: status.enabled ? (env.TURNSTILE_SITE_KEY as string) : null, turnstile: status, email: emailStatus(env), oauth: oauthProviders(env) });
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET');
