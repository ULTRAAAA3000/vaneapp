import type { Env } from '../../../types';
import { UUID_RE } from './http';
import { likeEscape } from './range';

export const SUPPORTED_RESULTS = ['bluesky', 'mastodon', 'devto'];
export const SUPPORTED_FOLLOWERS = ['bluesky', 'mastodon', 'telegram'];
export const SORTS = ['new', 'old', 'reactions', 'likes', 'replies', 'reposts', 'views'] as const;
export type Sort = (typeof SORTS)[number];

export const FREE_PAGE = 10;
export const PRO_PAGE = 20;

const SCORE = '(COALESCE(m.likes, 0) + COALESCE(m.replies, 0) + COALESCE(m.reposts, 0))';
const ORDER: Record<Sort, string> = {
  new: 'p.sent_at DESC',
  old: 'p.sent_at ASC',
  reactions: `${SCORE} DESC, p.sent_at DESC`,
  likes: 'COALESCE(m.likes, 0) DESC, p.sent_at DESC',
  replies: 'COALESCE(m.replies, 0) DESC, p.sent_at DESC',
  reposts: 'COALESCE(m.reposts, 0) DESC, p.sent_at DESC',
  views: 'COALESCE(m.views, 0) DESC, p.sent_at DESC',
};

export interface ChannelRow { id: string; type: string; name: string; now: number | null; first: number | null }

export async function listChannels(env: Env, userId: string, sinceDay: string): Promise<(ChannelRow & { results: boolean; followers: boolean; posts: number })[]> {
  const { results } = await env.DB
    .prepare(
      `SELECT c.id, c.type, c.name,
              (SELECT followers FROM channel_followers WHERE channel_id = c.id ORDER BY day DESC LIMIT 1) AS now,
              (SELECT followers FROM channel_followers WHERE channel_id = c.id AND day >= ?2 ORDER BY day ASC LIMIT 1) AS first,
              (SELECT COUNT(*) FROM posts p WHERE p.channel_id = c.id AND p.status = 'sent') AS posts
         FROM channels c WHERE c.user_id = ?1 ORDER BY posts DESC, c.created_at`,
    )
    .bind(userId, sinceDay)
    .all<ChannelRow & { posts: number }>();
  return results.map((r) => ({ ...r, results: SUPPORTED_RESULTS.includes(r.type), followers: SUPPORTED_FOLLOWERS.includes(r.type) }));
}

/** channels=all | id,id → the user's own channel ids; nothing valid → the busiest supported channel. */
export function pickChannels(param: string | null, owned: { id: string; results: boolean; followers: boolean }[]): string[] {
  const mine = new Set(owned.map((c) => c.id));
  if (param === 'all') return owned.filter((c) => c.results || c.followers).map((c) => c.id);
  const asked = (param ?? '').split(',').map((s) => s.trim()).filter((s) => UUID_RE.test(s) && mine.has(s));
  if (asked.length) return [...new Set(asked)].slice(0, 20);
  const first = owned.find((c) => c.results) ?? owned.find((c) => c.followers);
  return first ? [first.id] : [];
}

export interface Filter { userId: string; since: number; channels: string[]; q: string }

function where(f: Filter): { sql: string; args: unknown[] } {
  const args: unknown[] = [f.userId, f.since];
  let sql = `p.user_id = ?1 AND p.status = 'sent' AND p.sent_at >= ?2`;
  if (f.channels.length) { sql += ` AND p.channel_id IN (${f.channels.map((_, i) => `?${args.length + i + 1}`).join(',')})`; args.push(...f.channels); }
  else sql += ' AND 0';
  if (f.q) { sql += ` AND p.content LIKE ?${args.length + 1} ESCAPE '\\'`; args.push(`%${likeEscape(f.q)}%`); }
  return { sql, args };
}

const FROM = `FROM posts p JOIN channels c ON c.id = p.channel_id
  LEFT JOIN post_metrics m ON m.post_id = p.id AND m.stage = (SELECT MAX(stage) FROM post_metrics WHERE post_id = p.id)`;

export interface PostItem { id: string; channel_id: string; type: string; channel: string; content: string; sent_at: number; stage: number | null; views: number | null; likes: number | null; replies: number | null; reposts: number | null }

export async function queryPosts(env: Env, f: Filter, sort: Sort, limit: number, offset: number): Promise<{ total: number; items: PostItem[] }> {
  const w = where(f);
  const total = await env.DB.prepare(`SELECT COUNT(*) n ${FROM} WHERE ${w.sql}`).bind(...w.args).first<{ n: number }>();
  const { results } = await env.DB
    .prepare(
      `SELECT p.id, p.channel_id, c.type, c.name AS channel, substr(p.content, 1, 280) AS content, p.sent_at, m.stage, m.views, m.likes, m.replies, m.reposts
         ${FROM} WHERE ${w.sql} ORDER BY ${ORDER[sort]} LIMIT ${limit} OFFSET ${offset}`,
    )
    .bind(...w.args)
    .all<PostItem>();
  return { total: total?.n ?? 0, items: results };
}

export interface Totals { posts: number; views: number; likes: number; replies: number; reposts: number }

export async function queryTotals(env: Env, f: Filter): Promise<Totals> {
  const w = where(f);
  const r = await env.DB
    .prepare(`SELECT COUNT(*) posts, COALESCE(SUM(m.views),0) views, COALESCE(SUM(m.likes),0) likes, COALESCE(SUM(m.replies),0) replies, COALESCE(SUM(m.reposts),0) reposts ${FROM} WHERE ${w.sql}`)
    .bind(...w.args)
    .first<Totals>();
  return r ?? { posts: 0, views: 0, likes: 0, replies: 0, reposts: 0 };
}

export async function queryDaily(env: Env, f: Filter): Promise<{ day: string; posts: number; likes: number; replies: number; reposts: number; views: number }[]> {
  const w = where(f);
  const { results } = await env.DB
    .prepare(`SELECT date(p.sent_at, 'unixepoch') day, COUNT(*) posts, COALESCE(SUM(m.likes),0) likes, COALESCE(SUM(m.replies),0) replies, COALESCE(SUM(m.reposts),0) reposts, COALESCE(SUM(m.views),0) views ${FROM} WHERE ${w.sql} GROUP BY day ORDER BY day`)
    .bind(...w.args)
    .all<{ day: string; posts: number; likes: number; replies: number; reposts: number; views: number }>();
  return results;
}

export async function queryCompare(env: Env, f: Filter): Promise<{ channel_id: string; type: string; name: string; posts: number; reactions: number; views: number }[]> {
  const w = where(f);
  const { results } = await env.DB
    .prepare(`SELECT p.channel_id, c.type, c.name, COUNT(*) posts, COALESCE(SUM(${SCORE}),0) reactions, COALESCE(SUM(m.views),0) views ${FROM} WHERE ${w.sql} GROUP BY p.channel_id ORDER BY reactions DESC`)
    .bind(...w.args)
    .all<{ channel_id: string; type: string; name: string; posts: number; reactions: number; views: number }>();
  return results;
}

/** Average reactions per post for each weekday × 3-hour slot, in the user's own time zone. */
export async function queryBestTimes(env: Env, f: Filter, timeZone: string): Promise<{ grid: { n: number; avg: number }[][]; top: { day: number; slot: number; avg: number; n: number }[] }> {
  const w = where(f);
  const { results } = await env.DB
    .prepare(`SELECT p.sent_at, ${SCORE} AS score ${FROM} WHERE ${w.sql} AND m.stage IS NOT NULL ORDER BY p.sent_at DESC LIMIT 5000`)
    .bind(...w.args)
    .all<{ sent_at: number; score: number }>();
  let fmt: Intl.DateTimeFormat;
  try { fmt = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: 'numeric', hourCycle: 'h23' }); } catch { fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', hour: 'numeric', hourCycle: 'h23' }); }
  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const sum = Array.from({ length: 7 }, () => Array<number>(8).fill(0));
  const cnt = Array.from({ length: 7 }, () => Array<number>(8).fill(0));
  for (const r of results) {
    const parts = fmt.formatToParts(new Date(r.sent_at * 1000));
    const d = DAYS.indexOf(parts.find((p) => p.type === 'weekday')?.value ?? '');
    const h = Number(parts.find((p) => p.type === 'hour')?.value ?? -1);
    if (d < 0 || h < 0) continue;
    sum[d][Math.floor(h / 3)] += r.score;
    cnt[d][Math.floor(h / 3)]++;
  }
  const grid = sum.map((row, d) => row.map((s, i) => ({ n: cnt[d][i], avg: cnt[d][i] ? Math.round((s / cnt[d][i]) * 10) / 10 : 0 })));
  const top = grid.flatMap((row, day) => row.map((c, slot) => ({ day, slot, avg: c.avg, n: c.n }))).filter((c) => c.n >= 2).sort((a, b) => b.avg - a.avg || b.n - a.n).slice(0, 3);
  return { grid, top };
}
