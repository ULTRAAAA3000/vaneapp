/** DELETE /api/posts/:id — route file; the logic lives in ./cancel.ts */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { methodNotAllowed } from '../lib/http';
import { handleCancelPost } from './cancel';

export const onRequestDelete = handleCancelPost;
export const onRequest: PagesFunction<Env, 'id'> = async () => methodNotAllowed('DELETE');
