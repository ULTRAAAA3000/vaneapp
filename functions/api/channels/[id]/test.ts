/** POST /api/channels/:id/test — route file; the logic lives in ../index.ts */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../../types';
import { methodNotAllowed } from '../../lib/http';
import { handleTestChannel } from '../index';

export const onRequestPost = handleTestChannel;
export const onRequest: PagesFunction<Env, 'id'> = async () => methodNotAllowed('POST');
