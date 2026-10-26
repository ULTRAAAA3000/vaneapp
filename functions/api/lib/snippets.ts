import type { Env } from '../../../types';

export const SNIPPETS_FREE = 5;
export const SNIPPETS_PAID = 100;
export const TITLE_MAX = 60;
export const BODY_MAX = 2000;

export interface Snippet { id: string; title: string; body: string; updatedAt: number }

export const snippetLimit = (plan: string): number => (plan === 'free' ? SNIPPETS_FREE : SNIPPETS_PAID);

export async function listSnippets(env: Env, userId: string): Promise<Snippet[]> {
  const { results } = await env.DB
    .prepare('SELECT id, title, body, updated_at FROM post_snippets WHERE user_id = ?1 ORDER BY updated_at DESC, rowid DESC LIMIT ?2')
    .bind(userId, SNIPPETS_PAID)
    .all<{ id: string; title: string; body: string; updated_at: number }>();
  return results.map((r) => ({ id: r.id, title: r.title, body: r.body, updatedAt: r.updated_at }));
}

export async function saveSnippet(env: Env, userId: string, id: string | null, title: string, body: string, limit: number): Promise<{ ok: true; id: string } | { ok: false; code: 'limit' | 'missing' }> {
  if (id) {
    const res = await env.DB.prepare('UPDATE post_snippets SET title = ?3, body = ?4, updated_at = unixepoch() WHERE id = ?1 AND user_id = ?2').bind(id, userId, title, body).run();
    return res.meta.changes ? { ok: true, id } : { ok: false, code: 'missing' };
  }
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM post_snippets WHERE user_id = ?1').bind(userId).first<{ n: number }>();
  if ((row?.n ?? 0) >= limit) return { ok: false, code: 'limit' };
  const fresh = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO post_snippets (id, user_id, title, body) VALUES (?1, ?2, ?3, ?4)').bind(fresh, userId, title, body).run();
  return { ok: true, id: fresh };
}

export async function deleteSnippet(env: Env, userId: string, id: string): Promise<boolean> {
  const res = await env.DB.prepare('DELETE FROM post_snippets WHERE id = ?1 AND user_id = ?2').bind(id, userId).run();
  return res.meta.changes > 0;
}
