/** DELETE /api/channels/:id  — route file; the logic lives in ./index.ts */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { methodNotAllowed } from '../lib/http';
import { handleDeleteChannel } from './index';

export const onRequestDelete = handleDeleteChannel;
export const onRequest: PagesFunction<Env, 'id'> = async () => methodNotAllowed('DELETE');
