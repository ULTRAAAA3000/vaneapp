/** The browser side of connecting YouTube: state cookie, fixed callback address, where to send the person afterwards. This file is NOT a route. */
import { ROOT_DOMAIN, siteOf } from './hosts';

/** The browser side of connecting a Studio network (YouTube, Instagram): one cookie per network, scoped to that network's address. */
const cookieName = (net: string): string => (net === 'youtube' ? 'vane_yt' : `vane_vc_${net}`);
const TTL = 600;
export interface YtState { state: string; verifier: string; uid: string }

/** The main site in production (the one address Google knows), the request's own origin in local dev and previews. */
const base = (request: Request): string => {
  const u = new URL(request.url);
  return siteOf(u.hostname) === 'other' ? u.origin : `https://${ROOT_DOMAIN}`;
};
export const netCallback = (request: Request, net: string): string => `${base(request)}/api/video/channels/${net}/callback`;
export const youtubeCallback = (request: Request): string => netCallback(request, 'youtube');

/** Where the dashboard sends the person: always the main site (the state cookie must be set where Google will return). */
export const netStartUrl = (request: Request, net: string): string => `${base(request)}/api/video/channels/${net}/start`;
export const youtubeStartUrl = (request: Request): string => netStartUrl(request, 'youtube');

const attrs = (request: Request, maxAge: number, net: string): string => `Path=/api/video/channels/${net}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`;
export const ytStateCookie = (request: Request, v: YtState, net = 'youtube'): string => `${cookieName(net)}=${encodeURIComponent(JSON.stringify(v))}; ${attrs(request, TTL, net)}`;
export const ytClearedCookie = (request: Request, net = 'youtube'): string => `${cookieName(net)}=; ${attrs(request, 0, net)}`;

export function readYtState(request: Request, net = 'youtube'): YtState | null {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === cookieName(net)) {
      try {
        const v = JSON.parse(decodeURIComponent(part.slice(i + 1).trim())) as Partial<YtState>;
        if (typeof v.state === 'string' && typeof v.verifier === 'string' && typeof v.uid === 'string') return { state: v.state, verifier: v.verifier, uid: v.uid };
      } catch { /* a damaged cookie is the same as none */ }
    }
  }
  return null;
}

/** Back to Vane Studio with the result in the address (`connected=youtube` or `connect_error=<code>`). */
export function backToStudio(request: Request, query: string): Response {
  const u = new URL(request.url);
  const dest = siteOf(u.hostname) === 'other' ? `${u.origin}/studio` : `https://studio.${ROOT_DOMAIN}/`;
  return new Response(null, { status: 302, headers: { Location: `${dest}?${query}`, 'Cache-Control': 'no-store' } });
}
