/** POST /api/channels/threads/deauthorize — Meta's "user removed the app" call; the logic lives in ../threads-hooks.ts */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../../types';
import { methodNotAllowed } from '../../lib/http';
import { handleThreadsDeauthorize } from '../threads-hooks';

export const onRequestPost = handleThreadsDeauthorize;
export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('POST');
