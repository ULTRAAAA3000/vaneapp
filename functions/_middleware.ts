/**
 * Host routing: which product a request belongs to is decided by the host (see api/lib/hosts.ts).
 *
 *   post.vaneapp.dev     /  → the posting dashboard (public/app.html).  /app → /.  The video API is not served here.
 *   studio.vaneapp.dev   /  → the video dashboard (public/studio.html). /studio → /.  Only the video API, sign-in and keys are served here.
 *   vaneapp.dev          the landing page; /app and /studio forward to the product hosts.  The API keeps working (existing integrations).
 *   localhost, *.pages.dev   untouched.
 *
 * Why also gate the API per host: the two dashboards are independent products. A page on studio. has no business
 * calling the posting endpoints and the other way round, so the host that does not own a route answers 404.
 * (The sign-in cookie is shared across both hosts, see lib/session.ts, so one login covers both.)
 *
 * public/_routes.json lists the only paths that reach this function, so plain static files never invoke it.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../types';
import { fail } from './api/lib/http';
import { productUrl, siteOf } from './api/lib/hosts';

const VIDEO_API = ['/api/video/', '/api/v1/video/'];

/** What studio. may call: the video API, sign-in/out, and API keys (the video dashboard creates cvid_ keys). */
const STUDIO_API = [...VIDEO_API, '/api/auth/', '/api/keys'];

const startsWithAny = (path: string, prefixes: string[]): boolean => prefixes.some((p) => path === p.replace(/\/$/, '') || path.startsWith(p.endsWith('/') ? p : `${p}/`));

const route: PagesFunction<Env> = async ({ request, env, next }) => {
  const url = new URL(request.url);
  const site = siteOf(url.hostname);
  if (site === 'other') return next();

  const path = url.pathname;
  const page = request.method === 'GET' || request.method === 'HEAD';
  const here = (p: string): string => new URL(p, url).toString();
  const rewrite = (p: string): Promise<Response> => env.ASSETS.fetch(new Request(here(p), request));

  // ── API: each host serves only what belongs to its product
  if (path.startsWith('/api/')) {
    if (site === 'post' && startsWithAny(path, VIDEO_API)) return fail(404, 'Not found');
    if (site === 'studio' && !startsWithAny(path, STUDIO_API)) return fail(404, 'Not found');
    return next();
  }

  // ── pages
  if (!page) return next();
  if (site === 'post') {
    if (path === '/') return rewrite('/app');
    if (path === '/app') return Response.redirect(here('/'), 308);
    if (path === '/studio') return Response.redirect(productUrl('studio'), 308);
  } else if (site === 'studio') {
    if (path === '/') return rewrite('/studio');
    if (path === '/studio') return Response.redirect(here('/'), 308);
    if (path === '/app') return Response.redirect(productUrl('post'), 308);
  } else {
    if (path === '/app') return Response.redirect(productUrl('post'), 308);
    if (path === '/studio') return Response.redirect(productUrl('studio'), 308);
  }
  return next();
};

/**
 * Safety net for the API: anything a route throws (a missing table, a failing network call nobody caught) becomes a JSON answer with
 * a sentence the page can show, instead of the platform's own HTML error page ("Request failed (502)" in the dashboard). The real
 * reason goes to the log (Cloudflare → Pages → Functions → Real-time logs). Pages (non-API) keep their normal behaviour.
 */
export const onRequest: PagesFunction<Env> = async (context) => {
  try {
    return await route(context);
  } catch (err) {
    const { pathname } = new URL(context.request.url);
    if (!pathname.startsWith('/api/')) throw err;
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : 'unknown error';
    console.error(`unhandled error in ${context.request.method} ${pathname}: ${msg}`);
    // A table or column the code expects is not in the database yet: the schema has not been applied (npm run db:remote).
    if (/no such (table|column)/i.test(msg)) return fail(503, 'The server database needs one update (npm run db:remote). Please try again later.');
    return fail(500, 'Something went wrong on our side. Please try again in a moment.');
  }
};
