/** POST /api/channels/mastodon/start — route file; the logic lives in ../mastodon-oauth.ts */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../../types';
import { methodNotAllowed } from '../../lib/http';
import { handleMastodonStart } from '../mastodon-oauth';

export const onRequestPost = handleMastodonStart;
export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('POST');
