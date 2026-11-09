import type { Env } from '../../../types';
import { DELAY_MAX, DELAY_MIN } from './feeds';
import { UUID_RE } from './http';

export interface FeedViewRow {
  id: string; url: string; title: string | null; channel_ids: string; template: string; delay_minutes: number; enabled: number;
  last_checked_at: number | null; last_error: string | null; posted_count: number; created_at: number;
}

export const feedView = (r: FeedViewRow) => ({
  id: r.id, url: r.url, title: r.title, channelIds: JSON.parse(r.channel_ids) as string[], template: r.template, delayMinutes: r.delay_minutes,
  enabled: r.enabled === 1, lastCheckedAt: r.last_checked_at, lastError: r.last_error, postedCount: r.posted_count, createdAt: r.created_at,
});

export async function myActiveChannels(env: Env, userId: string, ids: string[]): Promise<boolean> {
  const { results } = await env.DB
    .prepare(`SELECT id FROM channels WHERE user_id = ?1 AND is_active = 1 AND id IN (${ids.map((_, i) => `?${i + 2}`).join(',')})`)
    .bind(userId, ...ids).all();
  return results.length === ids.length;
}

export function readChannelIds(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > 20) return null;
  const ids = [...new Set(v)];
  return ids.every((x): x is string => typeof x === 'string' && UUID_RE.test(x)) ? ids : null;
}

export function readDelay(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= DELAY_MIN && v <= DELAY_MAX ? v : null;
}
