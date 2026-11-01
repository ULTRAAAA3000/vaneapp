/**
 * Vane Studio (the Video Engine): who has it, and what it includes. The ONE place that knows its numbers.
 * Source of truth: ECONOMY_AND_FINANCE.md §2.5 ($12.00 / month) and §4.2 (the cost model is built on 90 stored videos).
 * Change a number there, change it here, nowhere else.
 *
 * Vane Studio is sold apart from Vane Post (Free / API / Pro), so it has its own table, `video_subscriptions`. The Suite bundle
 * (§2.6, $40.00: Post + Studio + Analytics Pro + AI Pass) will simply grant each subscription; no code here depends on how a subscription was paid for.
 * No row means no access: unlike the posting side there is no free trial for video (the docs define none).
 */
import type { Env } from '../../../types';
import { failCode } from './http';

export const VIDEO_ENGINE = {
  label: 'Vane Studio',
  priceUsd: 12,
  /** videos kept in the library at once (finished and being uploaded) */
  maxVideos: 90,
  /** one file, in bytes (the biggest long-form upload we accept) */
  maxFileBytes: 2 * 1024 ** 3,
} as const;

export type VideoSubscriptionStatus = 'active' | 'past_due' | 'canceled';

interface VideoSubscriptionRow {
  status: VideoSubscriptionStatus;
  current_period_end: number | null;
}

export interface VideoSubscription {
  /** may this account use the Video Engine RIGHT NOW? */
  active: boolean;
  /** 'none' = never had it */
  status: VideoSubscriptionStatus | 'none';
  /** unix seconds, null = no expiry (or no subscription) */
  currentPeriodEnd: number | null;
  /** it existed once and has stopped being active: a payment renews it */
  lapsed: boolean;
}

export const NO_VIDEO_SUBSCRIPTION: VideoSubscription = { active: false, status: 'none', currentPeriodEnd: null, lapsed: false };

/** Turns a stored row (or none) into what applies at `now`. */
export function resolveVideoSubscription(row: VideoSubscriptionRow | null | undefined, now: number): VideoSubscription {
  if (!row) return NO_VIDEO_SUBSCRIPTION;
  const expired = row.current_period_end !== null && row.current_period_end <= now;
  const active = row.status === 'active' && !expired;
  return { active, status: row.status, currentPeriodEnd: row.current_period_end, lapsed: !active };
}

export async function loadVideoSubscription(env: Pick<Env, 'DB'>, userId: string, now = Math.floor(Date.now() / 1000)): Promise<VideoSubscription> {
  const row = await env.DB
    .prepare('SELECT status, current_period_end FROM video_subscriptions WHERE user_id = ?1')
    .bind(userId)
    .first<VideoSubscriptionRow>();
  return resolveVideoSubscription(row, now);
}

export const videoEngineRequired = (): Response =>
  failCode(403, 'video_engine_required', 'Vane Studio (the Video Engine) is not active on your account.');

/** null when the account may use the Video Engine, otherwise the 403 to send back. */
export async function requireVideoAccess(env: Env, userId: string): Promise<Response | null> {
  return (await loadVideoSubscription(env, userId)).active ? null : videoEngineRequired();
}
