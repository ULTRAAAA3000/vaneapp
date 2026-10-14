/**
 * GET /api/posts?view=upcoming|history     (default: upcoming)
 *   upcoming → scheduled + processing, soonest first
 *   history  → sent + failed + cancelled, newest first
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env, PostPublic, PostStatus } from '../../../types';
import { requireUser } from '../lib/auth';
import { fail, json } from '../lib/http';

interface Row {
  id: string; group_id: string | null; channel_id: string; channel_name: string; channel_type: PostPublic['platform'];
  content: string; media_keys: string; scheduled_at: number; status: PostStatus; error: string | null; sent_at: number | null;
}

function firstMediaUrl(json: string): string | null {
  try {
    const arr = JSON.parse(json);
    const v = Array.isArray(arr) ? arr[0] : null;
    return typeof v === 'string' && v.startsWith('https://') ? v : null;
  } catch {
    return null;
  }
}

export const handleListPosts: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;

  const view = new URL(request.url).searchParams.get('view') ?? 'upcoming';
  if (view !== 'upcoming' && view !== 'history') return fail(400, 'view must be "upcoming" or "history"');

  const [statuses, order] =
    view === 'upcoming'
      ? ["'scheduled','processing'", 'p.scheduled_at ASC']
      : ["'sent','failed','cancelled'", 'p.scheduled_at DESC'];

  const { results } = await env.DB
    .prepare(
      `SELECT p.id, p.group_id, p.channel_id, c.name AS channel_name, c.type AS channel_type,
              p.content, p.media_keys, p.scheduled_at, p.status, p.error, p.sent_at
         FROM posts p JOIN channels c ON c.id = p.channel_id
        WHERE p.user_id = ?1 AND p.status IN (${statuses})
        ORDER BY ${order} LIMIT 200`,
    )
    .bind(auth.userId)
    .all<Row>();

  const posts: PostPublic[] = results.map((r) => ({
    id: r.id,
    groupId: r.group_id ?? r.id,
    channelId: r.channel_id,
    channelName: r.channel_name,
    platform: r.channel_type,
    content: r.content,
    mediaUrl: firstMediaUrl(r.media_keys),
    scheduledAt: r.scheduled_at,
    status: r.status,
    error: r.error,
    sentAt: r.sent_at,
  }));
  return json({ ok: true, posts });
};
