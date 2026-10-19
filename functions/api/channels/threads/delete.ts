/** POST /api/channels/threads/delete — Meta's "data deletion request" call; the logic lives in ../threads-hooks.ts */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../../types';
import { methodNotAllowed } from '../../lib/http';
import { handleThreadsDelete } from '../threads-hooks';

export const onRequestPost = handleThreadsDelete;
export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('POST');
