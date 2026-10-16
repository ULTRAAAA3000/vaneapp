/** GET /api/auth/config → { ok, turnstileSiteKey: string | null }  (public; lets /login render the human check) */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { json, methodNotAllowed } from '../lib/http';
import { turnstileEnabled } from '../lib/turnstile';

export const onRequestGet: PagesFunction<Env> = async ({ env }) =>
  json({ ok: true, turnstileSiteKey: turnstileEnabled(env) ? (env.TURNSTILE_SITE_KEY as string) : null });

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET');
