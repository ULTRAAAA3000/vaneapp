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
import { postUrl } from '../lib/postlink';
import { readTelegramChatId } from '../channels/credentials';

interface Row {
  id: string; group_id: string | null; channel_id: string; channel_name: string; channel_type: PostPublic['platform'];
  content: string; media_keys: string; scheduled_at: number; status: PostStatus; attempts: number; error: string | null; sent_at: number | null;
  external_id: string | null; credentials: string; // only used to build `url`, never returned
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
              p.content, p.media_keys, p.scheduled_at, p.status, p.attempts, p.error, p.sent_at, p.external_id, c.credentials
         FROM posts p JOIN channels c ON c.id = p.channel_id`;

function toPublic(r: Row, url: string | null): PostPublic {
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
    url,
  };
}

/**
 * Rows → public posts, each sent post with the link to open it on its network. Telegram needs the channel's chat for that, so the
 * saved credentials are decrypted once per Telegram channel in the list (a handful at most); nothing from them leaves this function.
 */
async function withLinks(env: Env, rows: Row[]): Promise<PostPublic[]> {
  const chats = new Map<string, string | null>();
  for (const r of rows) {
    if (r.channel_type === 'telegram' && r.status === 'sent' && r.external_id && !chats.has(r.channel_id)) {
      chats.set(r.channel_id, await readTelegramChatId(r.credentials, env.ENCRYPTION_KEY));
    }
  }
  return rows.map((r) => toPublic(r, r.status === 'sent' ? postUrl(r.channel_type, r.external_id, chats.get(r.channel_id)) : null));
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

  return json({ ok: true, posts: await withLinks(env, results) });
}

/** One post by id (mine only: someone else's id looks exactly like a missing one). */
export async function getPostForUser(env: Env, userId: string, id: string): Promise<Response> {
  if (!UUID_RE.test(id)) return fail(404, 'Post not found');
  const row = await env.DB.prepare(`${SELECT_POST} WHERE p.id = ?1 AND p.user_id = ?2`).bind(id, userId).first<Row>();
  if (!row) return fail(404, 'Post not found');
  return json({ ok: true, post: (await withLinks(env, [row]))[0] });
}

export const handleListPosts: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  return listPostsForUser(env, auth.userId, new URL(request.url).searchParams.get('view') ?? 'upcoming');
};
