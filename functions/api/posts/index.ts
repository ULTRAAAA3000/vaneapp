/** GET /api/posts (list) and POST /api/posts (create) — logic lives in ./list.ts and ./create.ts */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { methodNotAllowed } from '../lib/http';
import { handleCreatePost } from './create';
import { handleListPosts } from './list';

export const onRequestGet = handleListPosts;
export const onRequestPost = handleCreatePost;
export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET, POST');
