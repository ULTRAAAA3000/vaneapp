/**
 * GET /api/auth/config  (public)
 *   { ok, turnstileSiteKey: string | null, turnstile: { enabled, siteKeySet, secretKeySet } }
 * Lets /login render the human check. The status booleans make a half-configured deploy easy to
 * diagnose (open this URL): they say WHICH key the function cannot see, never the values.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { json, methodNotAllowed } from '../lib/http';
import { turnstileStatus, warnIfHalfConfigured } from '../lib/turnstile';

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  warnIfHalfConfigured(env);
  const status = turnstileStatus(env);
  return json({ ok: true, turnstileSiteKey: status.enabled ? (env.TURNSTILE_SITE_KEY as string) : null, turnstile: status });
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET');
