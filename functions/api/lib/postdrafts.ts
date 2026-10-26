import type { Env } from '../../../types';

export const DRAFTS_MAX = 5;

export interface DraftMedia { url: string; kind: 'image' | 'video'; name: string }
export interface Draft { id: string; content: string; channelIds: string[]; media: DraftMedia | null; updatedAt: number }

export async function listDrafts(env: Env, userId: string): Promise<Draft[]> {
  const { results } = await env.DB
    .prepare('SELECT id, content, channel_ids, media, updated_at FROM post_drafts WHERE user_id = ?1 ORDER BY updated_at DESC, rowid DESC LIMIT ?2')
    .bind(userId, DRAFTS_MAX)
    .all<{ id: string; content: string; channel_ids: string; media: string | null; updated_at: number }>();
  return results.map((r) => ({ id: r.id, content: r.content, channelIds: JSON.parse(r.channel_ids), media: r.media ? JSON.parse(r.media) : null, updatedAt: Math.floor(r.updated_at / 1000) }));
}

export async function saveDraft(env: Env, userId: string, id: string | null, content: string, channelIds: string[], media: DraftMedia | null): Promise<string | null> {
  const now = Date.now();
  const ids = JSON.stringify(channelIds);
  const m = media ? JSON.stringify(media) : null;
  if (id) {
    const res = await env.DB.prepare('UPDATE post_drafts SET content = ?3, channel_ids = ?4, media = ?5, updated_at = ?6 WHERE id = ?1 AND user_id = ?2').bind(id, userId, content, ids, m, now).run();
    if (res.meta.changes) return id;
  }
  const fresh = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO post_drafts (id, user_id, content, channel_ids, media, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)').bind(fresh, userId, content, ids, m, now).run();
  await env.DB
    .prepare('DELETE FROM post_drafts WHERE user_id = ?1 AND id NOT IN (SELECT id FROM post_drafts WHERE user_id = ?1 ORDER BY updated_at DESC, rowid DESC LIMIT ?2)')
    .bind(userId, DRAFTS_MAX)
    .run();
  return fresh;
}

export async function deleteDraft(env: Env, userId: string, id: string): Promise<boolean> {
  const res = await env.DB.prepare('DELETE FROM post_drafts WHERE id = ?1 AND user_id = ?2').bind(id, userId).run();
  return res.meta.changes > 0;
}
