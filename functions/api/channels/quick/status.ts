/** GET /api/channels/quick/status — route file; the logic lives in ../quick.ts */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../../types';
import { methodNotAllowed } from '../../lib/http';
import { handleQuickStatus } from '../quick';

export const onRequestGet = handleQuickStatus;
export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET');
