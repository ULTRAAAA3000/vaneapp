/** Cloudflare Turnstile: server-side check of the "are you human" token sent with sign-in / sign-up. */
import type { Env } from '../../../types';
import { fail } from './http';

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const MAX_TOKEN = 2048; // documented upper bound of a Turnstile token

/** Enforced only when BOTH keys are set, so a half-configured deploy can't lock everybody out. */
export const turnstileEnabled = (env: Env): boolean => Boolean(env.TURNSTILE_SECRET_KEY && env.TURNSTILE_SITE_KEY);

interface SiteVerify {
  success?: boolean;
  'error-codes'?: string[];
}

/**
 * null = the check passed (or Turnstile is not configured); otherwise the response to return.
 * Fails closed: if Cloudflare cannot be reached, nobody gets through.
 */
export async function requireHuman(env: Env, request: Request, token: unknown): Promise<Response | null> {
  if (!turnstileEnabled(env)) return null;
  if (typeof token !== 'string' || !token) return fail(400, 'Please complete the human check.');
  if (token.length > MAX_TOKEN) return fail(403, 'Human check failed. Please try again.');

  const form = new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY as string, response: token });
  const ip = request.headers.get('cf-connecting-ip');
  if (ip) form.set('remoteip', ip);

  let result: SiteVerify;
  try {
    const res = await fetch(VERIFY_URL, { method: 'POST', body: form, signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`siteverify ${res.status}`);
    result = (await res.json()) as SiteVerify;
  } catch (err) {
    console.error('turnstile siteverify failed', err instanceof Error ? err.message : 'unknown');
    return fail(503, 'Could not run the human check. Please try again.');
  }

  if (!result.success) {
    console.warn('turnstile rejected', (result['error-codes'] ?? []).join(','));
    return fail(403, 'Human check failed. Please try again.');
  }
  return null;
}
