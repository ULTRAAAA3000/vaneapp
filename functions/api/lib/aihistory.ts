import type { Env } from '../../../types';

export const HISTORY_TOOLS = ['generate', 'plan'];
export const HISTORY_MAX = 10;
export const HISTORY_MAX_PINNED = 4;

export interface HistoryEntry { id: string; tool: string; prompt: string; result: unknown; pinned: boolean; createdAt: number }

export async function saveHistory(env: Env, userId: string, tool: string, prompt: string, result: Record<string, unknown>): Promise<string | null> {
  if (!HISTORY_TOOLS.includes(tool)) return null;
  try {
    const id = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO ai_history (id, user_id, tool, prompt, result) VALUES (?1, ?2, ?3, ?4, ?5)').bind(id, userId, tool, prompt.slice(0, 2000), JSON.stringify(result)).run();
    await env.DB
      .prepare(`DELETE FROM ai_history WHERE user_id = ?1 AND pinned = 0 AND id NOT IN (SELECT id FROM ai_history WHERE user_id = ?1 ORDER BY pinned DESC, created_at DESC, rowid DESC LIMIT ?2)`)
      .bind(userId, HISTORY_MAX)
      .run();
    return id;
  } catch {
    return null;
  }
}

export async function listHistory(env: Env, userId: string): Promise<HistoryEntry[]> {
  const { results } = await env.DB
    .prepare('SELECT id, tool, prompt, result, pinned, created_at FROM ai_history WHERE user_id = ?1 ORDER BY pinned DESC, created_at DESC, rowid DESC LIMIT ?2')
    .bind(userId, HISTORY_MAX)
    .all<{ id: string; tool: string; prompt: string; result: string; pinned: number; created_at: number }>();
  return results.map((r) => ({ id: r.id, tool: r.tool, prompt: r.prompt, result: JSON.parse(r.result), pinned: r.pinned === 1, createdAt: r.created_at }));
}

export async function setPinned(env: Env, userId: string, id: string, pinned: boolean): Promise<'ok' | 'missing' | 'limit'> {
  if (pinned) {
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM ai_history WHERE user_id = ?1 AND pinned = 1 AND id <> ?2').bind(userId, id).first<{ n: number }>();
    if ((row?.n ?? 0) >= HISTORY_MAX_PINNED) return 'limit';
  }
  const res = await env.DB.prepare('UPDATE ai_history SET pinned = ?3 WHERE id = ?1 AND user_id = ?2').bind(id, userId, pinned ? 1 : 0).run();
  return res.meta.changes ? 'ok' : 'missing';
}

export async function deleteHistory(env: Env, userId: string, id: string): Promise<boolean> {
  const res = await env.DB.prepare('DELETE FROM ai_history WHERE id = ?1 AND user_id = ?2').bind(id, userId).run();
  return res.meta.changes > 0;
}
