import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../types';
import { json, methodNotAllowed } from './lib/http';
import { disabledModules } from './lib/modules';

export const onRequestGet: PagesFunction<Env> = async ({ env }) => json({ ok: true, off: await disabledModules(env) }, 200, { 'Cache-Control': 'public, max-age=15' });

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET');
