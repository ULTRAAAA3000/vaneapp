/**
 * The priority lane, "send on the second": for accounts on a paid plan.
 *
 * Cloudflare calls the cron worker once a minute, so a plain run can only send a post at the next whole minute: a post set for
 * 09:00:30 would leave at 09:01:00. This runs next to the minute's normal run and looks ahead instead: it finds paid posts due in
 * the next LOOKAHEAD_SECONDS, sleeps until each second (waiting costs no CPU), and then claims and sends what is due, right then.
 * A post due at 09:00:30 leaves at 09:00:30 (give or take the second the network takes to answer), not 09:01:00.
 *
 * What it does NOT promise: milliseconds. Cron fires at the start of a minute give or take a moment, the network answers when it
 * answers, and a post made less than about a minute ahead (such as "post now") is seen at the next minute's run, first in line.
 *
 * Safe by construction: the sleeping never claims anything. The claim is the same atomic scheduled → processing UPDATE as always,
 * made at the moment of sending, so a post cancelled during the wait is simply not there any more, and two runs can never send
 * the same post. The standard lane is untouched: it is claimed by its own statement (see Lane in ./dispatch.ts).
 */
import type { CronEnv } from '../../types';
import { paidUsersSql } from '../../functions/api/lib/paidsql';
import { runDuePosts, type RunSummary } from './dispatch';

/** How far ahead of the minute's run to look. Just under a minute: the next run takes over from there. */
export const LOOKAHEAD_SECONDS = 58;
/** Distinct seconds to wake up for in one minute (a burst beyond that is picked up by the next minute's run). */
export const MAX_WAKEUPS = 30;

/** The distinct seconds, in order, at which paid posts that are due for the first time fall in (now, now + lookahead]. */
export async function upcomingPrioritySeconds(env: Pick<CronEnv, 'DB'>, nowSec: number, lookahead = LOOKAHEAD_SECONDS, max = MAX_WAKEUPS): Promise<number[]> {
  const { results } = await env.DB
    .prepare(
      `SELECT DISTINCT scheduled_at FROM posts
        WHERE status = 'scheduled' AND attempts = 0 AND scheduled_at > ?1 AND scheduled_at <= ?2 AND ${paidUsersSql('user_id', '?1')}
        ORDER BY scheduled_at ASC LIMIT ?3`,
    )
    .bind(nowSec, nowSec + lookahead, max)
    .all<{ scheduled_at: number }>();
  return results.map((r) => r.scheduled_at);
}

/** What the lane needs from the outside: a clock, a way to wait, and the sender. Injected so the timing can be tested without waiting. */
export interface LaneDeps {
  now(): number;
  sleep(ms: number): Promise<void>;
  run(env: CronEnv, nowSec: number): Promise<RunSummary>;
}
export const realDeps: LaneDeps = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  run: (env, nowSec) => runDuePosts(env, nowSec, { lane: 'priority', housekeeping: false }),
};

export interface LaneResult { wakeups: number[]; claimed: number; sent: number; failed: number; retried: number }

export async function runPriorityLane(env: CronEnv, deps: LaneDeps = realDeps): Promise<LaneResult> {
  const out: LaneResult = { wakeups: [], claimed: 0, sent: 0, failed: 0, retried: 0 };
  if (!env.ENCRYPTION_KEY || env.ENCRYPTION_KEY.length < 32) return out;        // the same fail-safe as the main run: touch nothing
  const seconds = await upcomingPrioritySeconds(env, Math.floor(deps.now() / 1000));
  for (const sec of seconds) {
    for (let guard = 0; guard < 3 && deps.now() < sec * 1000; guard++) await deps.sleep(Math.max(1, sec * 1000 - deps.now()));
    const woke = Math.max(sec, Math.floor(deps.now() / 1000));
    const r = await deps.run(env, woke);
    out.wakeups.push(sec);
    out.claimed += r.claimed; out.sent += r.sent; out.failed += r.failed; out.retried += r.retried;
  }
  return out;
}
