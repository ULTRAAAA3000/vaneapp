/**
 * The hard stop for posts created from the dashboard (a post, "Post now", the "announce a video" post): the same quota and the same
 * balance as the API (see reservePosts in usage.ts). Past the quota nothing is created: the answer is a 402 whose text says what
 * happened, when the quota resets and what to do (add funds and switch on paying for extra use, or wait).
 */
import type { Env } from '../../../types';
import { fail, json } from './http';
import { refreshPlanSpecs } from './plans';
import { loadSubscription, reserveUiPost, stopBody, type Reservation } from './usage';

export type GateResult = { ok: true; reservation: Extract<Reservation, { ok: true }> } | { ok: false; response: Response };

export async function gateUiPost(env: Env, userId: string, now: number, units: number): Promise<GateResult> {
  await refreshPlanSpecs(env); // limits and prices come from the plans table (admin → Plans)
  const sub = await loadSubscription(env, userId, now);
  const r = await reserveUiPost(env, userId, sub, now, units);
  if (r.ok) return { ok: true, reservation: r };
  if (r.code === 'quota_exceeded') return { ok: false, response: json(await stopBody(env, userId, sub, now, 'posts', r.reason), 402) };
  return { ok: false, response: fail(403, 'Posting is not included in your plan.') };
}
