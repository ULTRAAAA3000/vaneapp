/** POST /api/channels/quick/start — route file; the logic lives in ../quick.ts */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../../types';
import { methodNotAllowed } from '../../lib/http';
import { handleQuickStart } from '../quick';

export const onRequestPost = handleQuickStart;
export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('POST');
