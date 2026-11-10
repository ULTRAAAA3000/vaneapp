/**
 * GET /api/posts/activity?offset=<minutes east of UTC>   how many posts went out on each day of the last year (one publication to
 * several channels counts once), for the activity calendar. The days are in the viewer's time zone.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { requireUser } from '../lib/auth';
import { json, methodNotAllowed } from '../lib/http';
import { nowSeconds } from '../lib/usage';

const DAYS = 371;

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  const asked = Number(new URL(request.url).searchParams.get('offset'));
  const offset = Number.isInteger(asked) && Math.abs(asked) <= 14 * 60 ? asked : 0;
  const since = nowSeconds() - DAYS * 86400;
  const { results } = await env.DB
    .prepare(
      `SELECT date(sent_at + ?3 * 60, 'unixepoch') AS day, COUNT(DISTINCT group_id) AS n
         FROM posts WHERE user_id = ?1 AND status = 'sent' AND sent_at >= ?2 GROUP BY day`,
    )
    .bind(auth.userId, since, offset)
    .all<{ day: string; n: number }>();
  const days: Record<string, number> = {};
  for (const r of results) days[r.day] = r.n;
  return json({ ok: true, days, offset });
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET');
