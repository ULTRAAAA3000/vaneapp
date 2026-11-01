import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../types';
import { previewPage } from '../api/lib/postpreview';

export const onRequestGet: PagesFunction<Env> = ({ env, request, params }) => previewPage(env, request, String(params.token ?? ''));
export const onRequestHead = onRequestGet;
