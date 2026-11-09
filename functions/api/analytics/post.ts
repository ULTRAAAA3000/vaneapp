import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { requireUser } from '../lib/auth';
import { isAnalyticsPro } from '../lib/analyticsdata';
import { fail, failCode, json, methodNotAllowed, UUID_RE } from '../lib/http';

/** How one post grew: the snapshots taken 1 hour, 24 hours, 7 days and 30 days after it went out (Pro). */
export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  if (!(await isAnalyticsPro(env, auth.userId))) return failCode(402, 'pro_required', 'The growth of a post over time is part of Analytics Pro.');
  const id = new URL(request.url).searchParams.get('id') ?? '';
  if (!UUID_RE.test(id)) return fail(400, 'Bad post id.');
  try {
    const own = await env.DB.prepare(`SELECT sent_at FROM posts WHERE id = ?1 AND user_id = ?2 AND status = 'sent'`).bind(id, auth.userId).first<{ sent_at: number }>();
    if (!own) return fail(404, 'Post not found.');
    const { results } = await env.DB
      .prepare('SELECT stage, taken_at, views, likes, replies, reposts FROM post_metrics WHERE post_id = ?1 ORDER BY stage')
      .bind(id)
      .all<{ stage: number; taken_at: number; views: number | null; likes: number | null; replies: number | null; reposts: number | null }>();
    return json({ ok: true, sentAt: own.sent_at, stages: results });
  } catch {
    return json({ ok: true, sentAt: null, stages: [] });
  }
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET');
