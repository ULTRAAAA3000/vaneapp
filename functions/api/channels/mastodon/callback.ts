/** GET /api/channels/mastodon/callback — route file; the logic lives in ../mastodon-oauth.ts */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../../types';
import { methodNotAllowed } from '../../lib/http';
import { handleMastodonCallback } from '../mastodon-oauth';

export const onRequestGet = handleMastodonCallback;
export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET');
