/** GET / HEAD /api/video/public/:token/cover — the cover of a publicly shared video (the link is the permission). Link previews and networks use it. */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../../../types';
import { fail, methodNotAllowed } from '../../../lib/http';
import { servePublicCover } from '../../../lib/videocover';

const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;
const tokenOf = (p: string | string[] | undefined) => (Array.isArray(p) ? p[0] : p) ?? '';

export const onRequestGet: PagesFunction<Env, 'token'> = ({ env, params }) => (TOKEN_RE.test(tokenOf(params.token)) ? servePublicCover(env, tokenOf(params.token), false) : fail(404, 'Not found'));
export const onRequestHead: PagesFunction<Env, 'token'> = ({ env, params }) => (TOKEN_RE.test(tokenOf(params.token)) ? servePublicCover(env, tokenOf(params.token), true) : fail(404, 'Not found'));
export const onRequest: PagesFunction<Env, 'token'> = async () => methodNotAllowed('GET, HEAD');
