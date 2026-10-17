/**
 * GET /api/posts?view=upcoming|history     (default: upcoming)
 *   upcoming → scheduled + processing, soonest first
 *   history  → sent + failed + cancelled, newest first
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env, PostPublic, PostStatus } from '../../../types';
import { requireUser } from '../lib/auth';
import { fail, json, UUID_RE } from '../lib/http';
import { mediaKindFromUrl } from '../lib/media';

interface Row {
  id: string; group_id: string | null; channel_id: string; channel_name: string; channel_type: PostPublic['platform'];
  content: string; media_keys: string; scheduled_at: number; status: PostStatus; attempts: number; error: string | null; sent_at: number | null;
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

const SELECT_POST = `SELECT p.id, p.group_id, p.channel_id, c.name AS channel_name, c.type AS channel_type,
              p.content, p.media_keys, p.scheduled_at, p.status, p.attempts, p.error, p.sent_at
         FROM posts p JOIN channels c ON c.id = p.channel_id`;

function toPublic(r: Row): PostPublic {
  const media = firstMediaUrl(r.media_keys);
  return {
    id: r.id,
    groupId: r.group_id ?? r.id,
    channelId: r.channel_id,
    channelName: r.channel_name,
    platform: r.channel_type,
    content: r.content,
    mediaUrl: media,
    mediaKind: media ? mediaKindFromUrl(media) : null,
    scheduledAt: r.scheduled_at,
    status: r.status,
    attempts: r.attempts,
    error: r.error,
    sentAt: r.sent_at,
  };
}

/** The list for one user. Shared by the dashboard route and `GET /api/v1/posts`. */
export async function listPostsForUser(env: Env, userId: string, view: string): Promise<Response> {
  if (view !== 'upcoming' && view !== 'history') return fail(400, 'view must be "upcoming" or "history"');

  const [statuses, order] =
    view === 'upcoming'
      ? ["'scheduled','processing'", 'p.scheduled_at ASC']
      : ["'sent','failed','cancelled'", 'p.scheduled_at DESC'];

  // `statuses` and `order` are fixed literals chosen above, never request input.
  const { results } = await env.DB
    .prepare(`${SELECT_POST} WHERE p.user_id = ?1 AND p.status IN (${statuses}) ORDER BY ${order} LIMIT 200`)
    .bind(userId)
    .all<Row>();

  return json({ ok: true, posts: results.map(toPublic) });
}

/** One post by id (mine only: someone else's id looks exactly like a missing one). */
export async function getPostForUser(env: Env, userId: string, id: string): Promise<Response> {
  if (!UUID_RE.test(id)) return fail(404, 'Post not found');
  const row = await env.DB.prepare(`${SELECT_POST} WHERE p.id = ?1 AND p.user_id = ?2`).bind(id, userId).first<Row>();
  if (!row) return fail(404, 'Post not found');
  return json({ ok: true, post: toPublic(row) });
}

export const handleListPosts: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  return listPostsForUser(env, auth.userId, new URL(request.url).searchParams.get('view') ?? 'upcoming');
};
