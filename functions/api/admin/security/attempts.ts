/** GET /api/admin/security/attempts?kind=login|register|admin_login&ok=0|1&ip=&q=&page=1 → the attempts feed (50 per page) */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../../types';
import { requireAdmin } from '../../lib/admin';
import { json, methodNotAllowed } from '../../lib/http';
import { likeEscape } from '../../lib/range';

const PAGE = 50;

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;
  const p = new URL(request.url).searchParams;
  const where: string[] = [];
  const binds: unknown[] = [];
  // every "?" in `sql` becomes the same numbered parameter, so one value can be used several times
  const add = (sql: string, v: unknown) => { binds.push(v); where.push(sql.split('?').join(`?${binds.length}`)); };

  const kind = p.get('kind');
  if (kind === 'login' || kind === 'register' || kind === 'admin_login') add('kind = ?', kind);
  const ok = p.get('ok');
  if (ok === '0' || ok === '1') add('ok = ?', Number(ok));
  const ip = (p.get('ip') ?? '').trim().slice(0, 45);
  if (ip) add('ip = ?', ip);
  const q = (p.get('q') ?? '').trim().slice(0, 100);
  if (q) add(`(email LIKE ? ESCAPE '\\' OR reason LIKE ? ESCAPE '\\' OR as_org LIKE ? ESCAPE '\\')`, `%${likeEscape(q)}%`);
  const clause = where.join(' AND ');
  const page = Math.max(1, Math.min(10_000, Number(p.get('page')) || 1));

  const sql = `FROM auth_attempts${clause ? ` WHERE ${clause}` : ''}`;
  const [rows, total] = await env.DB.batch([
    env.DB.prepare(`SELECT id, ts, kind, ok, reason, email, ip, country, city, asn, as_org, ua ${sql} ORDER BY id DESC LIMIT ${PAGE} OFFSET ${(page - 1) * PAGE}`).bind(...binds),
    env.DB.prepare(`SELECT COUNT(*) n ${sql}`).bind(...binds),
  ]);
  return json({ ok: true, page, pageSize: PAGE, total: (total.results[0] as { n: number }).n, attempts: rows.results });
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET');
