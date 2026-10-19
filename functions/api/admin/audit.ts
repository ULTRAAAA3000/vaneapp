/** GET /api/admin/audit → the last 200 changes made in the admin panel */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { requireAdmin } from '../lib/admin';
import { json, methodNotAllowed } from '../lib/http';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;
  const { results } = await env.DB.prepare('SELECT id, ts, action, target, detail, ip FROM admin_audit ORDER BY id DESC LIMIT 200').all();
  return json({ ok: true, entries: results });
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET');
