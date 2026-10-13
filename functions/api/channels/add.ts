/** POST /api/channels/add  — route file; the logic lives in ./index.ts */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { methodNotAllowed } from '../lib/http';
import { handleAddChannel } from './index';

export const onRequestPost = handleAddChannel;
export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('POST');
