/** POST /api/channels/linkedin/start — route file; the logic lives in ../social-oauth.ts */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../../types';
import { methodNotAllowed } from '../../lib/http';
import { startHandler } from '../social-oauth';

export const onRequestPost = startHandler('linkedin');
export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('POST');
