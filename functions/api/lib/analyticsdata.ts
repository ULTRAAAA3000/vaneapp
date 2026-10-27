import type { Env } from '../../../types';
import { loadSubscription, nowSeconds } from './usage';

export const FREE_POSTS = 10;
export const FREE_DAYS = 30;
export const PRO_DAYS = 365;

export async function isAnalyticsPro(env: Env, userId: string, now = nowSeconds()): Promise<boolean> {
  const sub = await loadSubscription(env, userId, now);
  if (sub.plan === 'suite' || sub.plan === 'agency') return true;
  const row = await env.DB
    .prepare('SELECT status, current_period_end FROM analytics_subscriptions WHERE user_id = ?1')
    .bind(userId)
    .first<{ status: string; current_period_end: number | null }>();
  return !!row && row.status === 'active' && (row.current_period_end === null || row.current_period_end > now);
}

export interface PostRow {
  id: string;
  channel_id: string;
  type: string;
  channel: string;
  content: string;
  sent_at: number;
  stage: number | null;
  views: number | null;
  likes: number | null;
  replies: number | null;
  reposts: number | null;
}

export async function listPostResults(env: Env, userId: string, since: number, limit: number): Promise<PostRow[]> {
  const { results } = await env.DB
    .prepare(
      `SELECT p.id, p.channel_id, c.type, c.name AS channel, substr(p.content, 1, 160) AS content, p.sent_at,
              m.stage, m.views, m.likes, m.replies, m.reposts
         FROM posts p
         JOIN channels c ON c.id = p.channel_id
         LEFT JOIN post_metrics m ON m.post_id = p.id AND m.stage = (SELECT MAX(stage) FROM post_metrics WHERE post_id = p.id)
        WHERE p.user_id = ?1 AND p.status = 'sent' AND p.sent_at >= ?2
        ORDER BY p.sent_at DESC LIMIT ?3`,
    )
    .bind(userId, since, limit)
    .all<PostRow>();
  return results;
}

export interface FollowerRow { channel_id: string; type: string; name: string; now: number | null; first: number | null }

export async function followerSummary(env: Env, userId: string, sinceDay: string): Promise<FollowerRow[]> {
  const { results } = await env.DB
    .prepare(
      `SELECT c.id AS channel_id, c.type, c.name,
              (SELECT followers FROM channel_followers WHERE channel_id = c.id ORDER BY day DESC LIMIT 1) AS now,
              (SELECT followers FROM channel_followers WHERE channel_id = c.id AND day >= ?2 ORDER BY day ASC LIMIT 1) AS first
         FROM channels c
        WHERE c.user_id = ?1 AND c.type IN ('bluesky', 'mastodon', 'telegram', 'devto')
        ORDER BY c.created_at`,
    )
    .bind(userId, sinceDay)
    .all<FollowerRow>();
  return results;
}

export async function followerSeries(env: Env, userId: string, sinceDay: string): Promise<{ channel_id: string; day: string; followers: number }[]> {
  const { results } = await env.DB
    .prepare(
      `SELECT f.channel_id, f.day, f.followers FROM channel_followers f JOIN channels c ON c.id = f.channel_id
        WHERE c.user_id = ?1 AND f.day >= ?2 ORDER BY f.day`,
    )
    .bind(userId, sinceDay)
    .all<{ channel_id: string; day: string; followers: number }>();
  return results;
}
