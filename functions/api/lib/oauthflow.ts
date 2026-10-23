/** The browser-side half of the OAuth sign-in: the state cookie, the fixed callback address and where to send the person afterwards. */
import { ROOT_DOMAIN, siteOf } from './hosts';
import type { Provider } from './oauthlogin';

const COOKIE = 'vane_oauth';
const TTL = 600;

export interface OAuthState { p: Provider; state: string; verifier: string; product: 'post' | 'studio'; next: string }

/** The main site in production (one fixed address the provider knows), the request's own origin in local dev and previews. */
const siteBase = (request: Request): string => {
  const u = new URL(request.url);
  return siteOf(u.hostname) === 'other' ? u.origin : `https://${ROOT_DOMAIN}`;
};

export const callbackUrl = (request: Request, p: Provider): string => `${siteBase(request)}/api/auth/oauth/${p}/callback`;

const attrs = (request: Request, maxAge: number): string => `Path=/api/auth/oauth; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`;
export const stateCookie = (request: Request, value: string): string => `${COOKIE}=${encodeURIComponent(value)}; ${attrs(request, TTL)}`;
export const clearedStateCookie = (request: Request): string => `${COOKIE}=; ${attrs(request, 0)}`;

export function readState(request: Request): OAuthState | null {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE) {
      try {
        const v = JSON.parse(decodeURIComponent(part.slice(i + 1).trim())) as Partial<OAuthState>;
        if ((v.p === 'github' || v.p === 'google') && typeof v.state === 'string' && typeof v.verifier === 'string') {
          return { p: v.p, state: v.state, verifier: v.verifier, product: v.product === 'studio' ? 'studio' : 'post', next: typeof v.next === 'string' && /^\/checkout(\?[A-Za-z0-9=&%._-]*)?$/.test(v.next) ? v.next : '' };
        }
      } catch { /* a damaged cookie is the same as none */ }
    }
  }
  return null;
}

export const loginRedirect = (request: Request, error: string): Response =>
  new Response(null, { status: 302, headers: { Location: `${siteBase(request)}/login?error=${error}`, 'Cache-Control': 'no-store' } });

export function successUrl(request: Request, product: 'post' | 'studio', next: string): string {
  const base = siteBase(request);
  if (next) return base + next;
  if (siteOf(new URL(request.url).hostname) === 'other') return `${base}/${product === 'studio' ? 'studio' : 'app'}`;
  return `https://${product}.${ROOT_DOMAIN}/`;
}
