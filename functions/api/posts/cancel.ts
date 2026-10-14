/** DELETE /api/posts/:id  → cancels a post that has not been sent yet */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { requireUser } from '../lib/auth';
import { fail, json, UUID_RE } from '../lib/http';

export const handleCancelPost: PagesFunction<Env, 'id'> = async ({ request, env, params }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;

  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  if (!id || !UUID_RE.test(id)) return fail(404, 'Post not found');

  const now = Math.floor(Date.now() / 1000);
  // Atomic: only a post that is still 'scheduled' can be cancelled, so we can't race the sender.
  const res = await env.DB
    .prepare(`UPDATE posts SET status = 'cancelled', updated_at = ?3 WHERE id = ?1 AND user_id = ?2 AND status = 'scheduled'`)
    .bind(id, auth.userId, now)
    .run();
  if ((res.meta?.changes ?? 0) > 0) return json({ ok: true });

  const row = await env.DB.prepare('SELECT status FROM posts WHERE id = ?1 AND user_id = ?2').bind(id, auth.userId).first<{ status: string }>();
  if (!row) return fail(404, 'Post not found');
  return fail(409, `This post is already ${row.status} and can't be cancelled.`);
};
