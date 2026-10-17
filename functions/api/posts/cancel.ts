/** DELETE /api/posts/:id  → cancels a post that has not been sent yet */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { requireUser } from '../lib/auth';
import { fail, json, UUID_RE } from '../lib/http';

/**
 * Shared by the dashboard route and `DELETE /api/v1/posts/:id`.
 * `dryRun` (test-mode API keys) runs every check and answers as usual but changes nothing.
 */
export async function cancelPostForUser(env: Env, userId: string, id: string | undefined, dryRun = false): Promise<Response> {
  if (!id || !UUID_RE.test(id)) return fail(404, 'Post not found');

  if (dryRun) {
    const row = await env.DB.prepare('SELECT status FROM posts WHERE id = ?1 AND user_id = ?2').bind(id, userId).first<{ status: string }>();
    if (!row) return fail(404, 'Post not found');
    if (row.status !== 'scheduled') return fail(409, `This post is already ${row.status} and can't be cancelled.`);
    return json({ ok: true, test: true });
  }

  const now = Math.floor(Date.now() / 1000);
  // Atomic: only a post that is still 'scheduled' can be cancelled, so we can't race the sender.
  const res = await env.DB
    .prepare(`UPDATE posts SET status = 'cancelled', updated_at = ?3 WHERE id = ?1 AND user_id = ?2 AND status = 'scheduled'`)
    .bind(id, userId, now)
    .run();
  if ((res.meta?.changes ?? 0) > 0) return json({ ok: true });

  const row = await env.DB.prepare('SELECT status FROM posts WHERE id = ?1 AND user_id = ?2').bind(id, userId).first<{ status: string }>();
  if (!row) return fail(404, 'Post not found');
  return fail(409, `This post is already ${row.status} and can't be cancelled.`);
}

export const handleCancelPost: PagesFunction<Env, 'id'> = async ({ request, env, params }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  return cancelPostForUser(env, auth.userId, Array.isArray(params.id) ? params.id[0] : params.id);
};
