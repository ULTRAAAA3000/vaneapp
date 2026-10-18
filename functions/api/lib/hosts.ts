/**
 * The hosts Vane runs on. One Pages project answers on all of them; the host decides WHICH product a visitor gets
 * (ECONOMY_AND_FINANCE.md §1: Vane Post = post.vaneapp.dev, Vane Studio = studio.vaneapp.dev).
 *
 *   vaneapp.dev / www   the site (landing page, sign-in). Its old /app and /studio links forward to the products' own hosts.
 *   post.vaneapp.dev    Vane Post: the posting dashboard
 *   studio.vaneapp.dev  Vane Studio: the video dashboard
 *   anything else       local dev (localhost) and *.pages.dev previews: nothing is rewritten, /app and /studio both work
 */
export const ROOT_DOMAIN = 'vaneapp.dev';

export type Site = 'apex' | 'post' | 'studio' | 'other';

export function siteOf(hostname: string): Site {
  const h = hostname.toLowerCase();
  if (h === ROOT_DOMAIN || h === `www.${ROOT_DOMAIN}`) return 'apex';
  if (h === `post.${ROOT_DOMAIN}`) return 'post';
  if (h === `studio.${ROOT_DOMAIN}`) return 'studio';
  return 'other';
}

/** Absolute address of a product's own host. */
export const productUrl = (product: 'post' | 'studio', path = '/'): string => `https://${product}.${ROOT_DOMAIN}${path}`;

/**
 * `; Domain=vaneapp.dev` on our own hosts, so ONE sign-in covers post. and studio. (they are the same site, so SameSite=Lax
 * still applies). Empty on local dev, where a host-only cookie is what works.
 */
export const cookieDomain = (hostname: string): string => (siteOf(hostname) === 'other' ? '' : `; Domain=${ROOT_DOMAIN}`);
