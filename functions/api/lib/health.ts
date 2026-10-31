/**
 * What "All Systems Operational" means, in one place (GET /api/health uses it, scripts/status-unit.mjs tests it).
 *
 *   database     a trivial query (SELECT 1) answers
 *   publishing   no scheduled post is more than 5 minutes past its time, and nothing has sat in "processing" for more than 10
 *                minutes. The cron worker runs every minute, so a longer wait means it is not keeping up (or not running).
 *
 * operational = both fine · degraded = the database answers but publishing is late · down = the database does not answer.
 * Nothing here is invented: with no posts due, publishing is "ok" because nobody is waiting for anything.
 */
export const LATE_AFTER_S = 300;      // a scheduled post still waiting 5 minutes after its time
export const STUCK_AFTER_S = 600;     // a post in "processing" for 10 minutes

export type Health = {
  status: 'operational' | 'degraded' | 'down';
  checks: { database: 'ok' | 'error'; publishing: 'ok' | 'delayed' | 'unknown' };
  /** How long the oldest overdue post has been waiting, in seconds (only when publishing is delayed). */
  delaySeconds?: number;
};

/**
 * @param dbOk       did SELECT 1 answer
 * @param oldestDue  scheduled_at of the oldest post still in "scheduled" (null: none), unix seconds
 * @param stuckSince updated_at of the oldest post in "processing" (null: none), unix seconds
 * @param now        unix seconds
 */
export function evaluate(dbOk: boolean, oldestDue: number | null, stuckSince: number | null, now: number): Health {
  if (!dbOk) return { status: 'down', checks: { database: 'error', publishing: 'unknown' } };
  const late = oldestDue !== null && now - oldestDue > LATE_AFTER_S ? now - oldestDue : 0;
  const stuck = stuckSince !== null && now - stuckSince > STUCK_AFTER_S ? now - stuckSince : 0;
  const delay = Math.max(late, stuck);
  if (delay > 0) return { status: 'degraded', checks: { database: 'ok', publishing: 'delayed' }, delaySeconds: delay };
  return { status: 'operational', checks: { database: 'ok', publishing: 'ok' } };
}
