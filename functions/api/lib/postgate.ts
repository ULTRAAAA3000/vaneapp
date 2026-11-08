/**
 * The hard stop for posts created from the dashboard (a post, "Post now", the "announce a video" post): the same quota and the same
 * balance as the API (see reservePosts in usage.ts). Past the quota nothing is created: the answer is a 402 whose text says what
 * happened, when the quota resets and what to do (add funds and switch on paying for extra use, or wait).
 */
import type { Env } from '../../../types';
import { fail, failCode, json } from './http';
import { refreshPlanSpecs } from './plans';
import { loadSubscription, reserveUiPost, stopBody, usageSummary, type Reservation } from './usage';

/** `reservation` is null only when the usage tables are not in the database yet (right after a deploy, before the migration): then the post is allowed and not counted. */
export type GateResult = { ok: true; reservation: Extract<Reservation, { ok: true }> | null } | { ok: false; response: Response };

export async function gateUiPost(env: Env, userId: string, now: number, units: number): Promise<GateResult> {
  try {
    await refreshPlanSpecs(env); // limits and prices come from the plans table (admin → Plans)
    const sub = await loadSubscription(env, userId, now);
    const r = await reserveUiPost(env, userId, sub, now, units);
    if (r.ok) return { ok: true, reservation: r };
    if (r.code === 'quota_exceeded') return { ok: false, response: json(await stopBody(env, userId, sub, now, 'posts', r.reason), 402) };
    if (r.code === 'overage_cap_reached') {
      const usage = await usageSummary(env, userId, sub, now);
      return { ok: false, response: failCode(402, 'overage_cap_reached', `Your monthly extra-use limit of $${usage.overage.capUsd} is reached. Raise it in the dashboard (Usage), or wait for the 1st (UTC).`, { usage: { ui: usage.ui, resetsAt: usage.period.resetsAt, overage: usage.overage }, topUpUrl: '/topup' }) };
    }
    return { ok: false, response: fail(403, 'Posting is not included in your plan.') };
  } catch (err) {
    // Counting must never be the reason a post fails because a table is missing; any other error is a real error.
    if (/no such table/i.test(err instanceof Error ? err.message : '')) {
      console.error('ui quota skipped: the usage tables are missing. Apply schema.sql.');
      return { ok: true, reservation: null };
    }
    throw err;
  }
}
