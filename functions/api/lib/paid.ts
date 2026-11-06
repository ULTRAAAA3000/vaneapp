/**
 * "Paid" in one place: an account is on a paid plan OF THE POSTING DASHBOARD when its subscription is active, is not the Free Trial and
 * includes dashboard posts (Pro Dashboard, the Suite, any plan made in /admin with posts a month). The Developer API plan is a
 * headless gateway with no dashboard, so it is not one. A plan that ended or was cancelled counts as free (resolveSubscription
 * already says so for the app; ./paidsql.ts says the same thing for the cron worker, which asks about many accounts at once).
 *
 * Paid plans get: the priority dispatch lane (worker/src/priority.ts), the advanced MCP tools (v1/mcp.ts).
 */
import type { Env } from '../../../types';
import { specOf } from './plans';
import { loadSubscription } from './usage';

/** Is this plan one of the posting dashboard's paid plans? (The plan specs must have been loaded: loadSubscription does that.) */
export const isDashboardPlan = (planId: string): boolean => planId !== 'free' && specOf(planId).ui > 0;

/** Is the account on a paid plan of the posting dashboard right now? Any trouble reading the plan counts as "no". */
export async function isPaidAccount(env: Pick<Env, 'DB'>, userId: string, now = Math.floor(Date.now() / 1000)): Promise<boolean> {
  try { return isDashboardPlan((await loadSubscription(env as Env, userId, now)).plan); } catch { return false; }
}

export { paidUsersSql } from './paidsql';
