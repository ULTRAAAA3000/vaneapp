/** POST /api/posts  — route file; the logic lives in ./create.ts */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { methodNotAllowed } from '../lib/http';
import { handleCreatePost } from './create';

export const onRequestPost = handleCreatePost;
export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('POST');
