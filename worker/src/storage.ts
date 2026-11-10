import type { CronEnv, Env } from '../../types';
import { GRACE_SECONDS, clearOver, markOver, removeNewestUntilFits, storageLimit } from '../../functions/api/lib/library';
import { getSettings } from '../../functions/api/lib/settings';
import { isMissingTable } from '../../functions/api/lib/socials';
import { emailConfigured, sendMail } from '../../functions/api/lib/mail';
import { OVER_EVENT, REMIND_BEFORE_SECONDS, REMIND_EVENT, REMOVED_EVENT, overMail, remindMail, removedMail, type StorageMailContext } from '../../functions/api/lib/storagemail';

const BATCH = 500;

export const isStorageMinute = (nowSec: number): boolean => Math.floor(nowSec / 60) % 60 === 7;

/** Was this email already sent during the current overage (since the day the account went over)? */
async function alreadySent(env: Env, userId: string, event: string, since: number): Promise<boolean> {
  const r = await env.DB.prepare('SELECT 1 AS x FROM logs WHERE user_id = ?1 AND event = ?2 AND created_at >= ?3 LIMIT 1').bind(userId, event, since).first();
  return Boolean(r);
}
async function logSent(env: Env, userId: string, event: string, meta: unknown, nowSec: number): Promise<void> {
  await env.DB.prepare(`INSERT INTO logs (user_id, level, event, meta, created_at) VALUES (?1, 'info', ?2, ?3, ?4)`).bind(userId, event, JSON.stringify(meta), nowSec).run();
}

/**
 * The 3 days to clean up are not silent: one email the hour the account goes over, one in the last 24 hours before the newest uploads go,
 * and one after the clean-up. A failed send is simply tried again at the next hourly run (nothing is logged until Resend accepts it).
 * Returns how many emails were sent. Without Resend configured (RESEND_API_KEY + EMAIL_FROM on the cron worker) it does nothing.
 */
async function mailAccount(env: Env, userId: string, kind: 'warn' | 'removed', ctx: StorageMailContext, since: number, nowSec: number): Promise<number> {
  try {
    if (!emailConfigured(env)) return 0;
    const user = await env.DB.prepare('SELECT email FROM users WHERE id = ?1').bind(userId).first<{ email: string }>();
    if (!user?.email) return 0;
    const meta = { usedBytes: ctx.usedBytes, limitBytes: ctx.limitBytes, deadline: ctx.deadline };
    if (kind === 'removed') {
      if (!(await sendMail(env, removedMail(user.email, ctx)))) return 0;
      await logSent(env, userId, REMOVED_EVENT, { ...meta, removed: ctx.removed }, nowSec);
      return 1;
    }
    const remindDue = nowSec >= ctx.deadline - REMIND_BEFORE_SECONDS;
    const first = !(await alreadySent(env, userId, OVER_EVENT, since));
    const remind = remindDue && !(await alreadySent(env, userId, REMIND_EVENT, since));
    if (!first && !remind) return 0;
    // when both are due at once (the account was only noticed in its last day) the reminder says everything: one email, both marked
    if (!(await sendMail(env, remindDue ? remindMail(user.email, ctx, nowSec) : overMail(user.email, ctx)))) return 0;
    await logSent(env, userId, OVER_EVENT, meta, nowSec);
    if (remindDue) await logSent(env, userId, REMIND_EVENT, meta, nowSec);
    return 1;
  } catch (err) {
    console.error('vane-cron: storage email failed for one account:', err instanceof Error ? err.message : 'unknown');
    return 0;
  }
}

export async function runStoragePurge(cron: CronEnv, nowSec: number): Promise<{ marked: number; removed: number; mailed: number }> {
  const env = cron as unknown as Env;
  const out = { marked: 0, removed: 0, mailed: 0 };
  const origin = (env.APP_URL ?? 'https://vaneapp.dev').replace(/\/+$/, '');
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
      try {
        const limit = await storageLimit(env, row.user_id);
        if (limit.bytes === null || row.bytes <= limit.bytes) { await clearOver(env, row.user_id); continue; }
        const since = await markOver(env, row.user_id, nowSec);
        if (since === null) continue;
        out.marked++;
        const deadline = since + GRACE_SECONDS;
        const ctx: StorageMailContext = { planLabel: limit.label, usedBytes: row.bytes, limitBytes: limit.bytes, deadline, origin };
        if (nowSec < deadline) { out.mailed += await mailAccount(env, row.user_id, 'warn', ctx, since, nowSec); continue; }
        const removed = await removeNewestUntilFits(env, row.user_id, limit.bytes);
        out.removed += removed;
        const left = await env.DB.prepare('SELECT COALESCE(SUM(size_bytes), 0) AS bytes FROM media_assets WHERE user_id = ?1').bind(row.user_id).first<{ bytes: number }>();
        if (removed > 0) out.mailed += await mailAccount(env, row.user_id, 'removed', { ...ctx, usedBytes: left?.bytes ?? 0, removed }, since, nowSec);
        if ((left?.bytes ?? 0) <= limit.bytes) await clearOver(env, row.user_id);
      } catch (err) {
        // one account that fails (a storage error on one of its files) must not stop the others; it is tried again next hour
        console.error('vane-cron: storage clean-up failed for one account:', err instanceof Error ? err.message : 'unknown');
      }
    }
    await env.DB.prepare('DELETE FROM storage_overages WHERE user_id NOT IN (SELECT DISTINCT user_id FROM media_assets)').run();
  } catch (err) {
    if (!isMissingTable(err)) throw err;
  }
  return out;
}
