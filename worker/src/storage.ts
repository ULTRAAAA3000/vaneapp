import type { CronEnv, Env } from '../../types';
import { GRACE_SECONDS, clearOver, markOver, removeNewestUntilFits, storageLimit } from '../../functions/api/lib/library';
import { getSettings } from '../../functions/api/lib/settings';
import { isMissingTable } from '../../functions/api/lib/socials';

const BATCH = 500;

export const isStorageMinute = (nowSec: number): boolean => Math.floor(nowSec / 60) % 60 === 7;

export async function runStoragePurge(cron: CronEnv, nowSec: number): Promise<{ marked: number; removed: number }> {
  const env = cron as unknown as Env;
  const out = { marked: 0, removed: 0 };
  try {
    if (!(await getSettings(env)).enforce_limits) {
      await env.DB.prepare('DELETE FROM storage_overages').run();
      return out;
    }
    const { results } = await env.DB
      .prepare('SELECT user_id, SUM(size_bytes) AS bytes FROM media_assets GROUP BY user_id ORDER BY bytes DESC LIMIT ?1')
      .bind(BATCH)
      .all<{ user_id: string; bytes: number }>();
    for (const row of results) {
      const limit = await storageLimit(env, row.user_id);
      if (limit.bytes === null || row.bytes <= limit.bytes) { await clearOver(env, row.user_id); continue; }
      const since = await markOver(env, row.user_id, nowSec);
      if (since === null) continue;
      out.marked++;
      if (nowSec - since < GRACE_SECONDS) continue;
      out.removed += await removeNewestUntilFits(env, row.user_id, limit.bytes);
      const left = await env.DB.prepare('SELECT COALESCE(SUM(size_bytes), 0) AS bytes FROM media_assets WHERE user_id = ?1').bind(row.user_id).first<{ bytes: number }>();
      if ((left?.bytes ?? 0) <= limit.bytes) await clearOver(env, row.user_id);
    }
    await env.DB.prepare('DELETE FROM storage_overages WHERE user_id NOT IN (SELECT DISTINCT user_id FROM media_assets)').run();
  } catch (err) {
    if (!isMissingTable(err)) throw err;
  }
  return out;
}
