/** GET /api/channels/pinterest/callback — route file; the logic lives in ../social-oauth.ts */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../../types';
import { methodNotAllowed } from '../../lib/http';
import { callbackHandler } from '../social-oauth';

export const onRequestGet = callbackHandler('pinterest');
export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET');
