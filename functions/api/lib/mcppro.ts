/**
 * The advanced MCP tools of the paid plans (v1/mcp.ts): what turns an AI assistant from "a send button" into something that can
 * look at how your posts did, pick the times, write in your voice and schedule a whole run in one go.
 *
 *   vane_analyze_performance   facts and patterns from your own past posts and their measured results
 *   vane_best_times            the best free slots of the coming days, from your own results (sensible defaults without data)
 *   vane_get_voice             your saved tone of voice, so the assistant writes like you
 *   vane_create_series         schedule up to 14 posts in one call (one tool call instead of fourteen)
 *
 * Honest about what is computed here and what is not: this file does arithmetic on YOUR data (counts, averages, buckets) and the
 * assistant does the thinking (what to change, what to write). Nothing here calls an AI model, so none of it spends AI credits.
 */
import type { Env } from '../../../types';

export const MAX_SERIES = 14;
export const MIN_LEAD_SECONDS = 60;
export const MAX_AHEAD_SECONDS = 365 * 86400;

export interface PerfRow {
  id: string; type: string; sent_at: number; len: number; has_media: number; snippet: string;
  views: number | null; likes: number | null; replies: number | null; reposts: number | null;
}

/** Sent posts of the last `days`, newest first, each with its latest measured results (null = not measured yet). */
export async function loadPerformance(env: Env, userId: string, since: number, limit = 300): Promise<PerfRow[]> {
  const { results } = await env.DB
    .prepare(
      `SELECT p.id, c.type, p.sent_at, length(p.content) AS len, (p.media_keys IS NOT NULL AND p.media_keys NOT IN ('', '[]')) AS has_media,
              substr(p.content, 1, 120) AS snippet, m.views, m.likes, m.replies, m.reposts
         FROM posts p
         JOIN channels c ON c.id = p.channel_id
         LEFT JOIN post_metrics m ON m.post_id = p.id AND m.stage = (SELECT MAX(stage) FROM post_metrics WHERE post_id = p.id)
        WHERE p.user_id = ?1 AND p.status = 'sent' AND p.sent_at >= ?2
        ORDER BY p.sent_at DESC LIMIT ?3`,
    )
    .bind(userId, since, limit)
    .all<PerfRow>();
  return results;
}

const reactions = (r: PerfRow): number => (r.likes ?? 0) + (r.replies ?? 0) + (r.reposts ?? 0);
const measured = (r: PerfRow): boolean => r.views !== null || r.likes !== null || r.replies !== null || r.reposts !== null;
const avg = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const fmt = (n: number): string => (n >= 100 ? String(Math.round(n)) : n.toFixed(1).replace(/\.0$/, ''));

export interface Bucket { label: string; n: number; avg: number }
export interface Analysis {
  total: number; measured: number;
  byPlatform: { platform: string; posts: number; measured: number; avgReactions: number; views: number }[];
  top: PerfRow[]; bottom: PerfRow[];
  byWeekday: Bucket[]; bySlot: Bucket[]; byLength: Bucket[]; byMedia: Bucket[];
  enough: boolean;
}

/** Below this many measured posts the patterns are noise; the numbers are still shown but the assistant is told not to lean on them. */
export const ENOUGH_MEASURED = 8;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function buckets(rows: PerfRow[], key: (r: PerfRow) => string, order: string[]): Bucket[] {
  const groups = new Map<string, number[]>();
  for (const r of rows) groups.set(key(r), [...(groups.get(key(r)) ?? []), reactions(r)]);
  return order.filter((k) => groups.has(k)).map((k) => ({ label: k, n: groups.get(k)!.length, avg: avg(groups.get(k)!) }));
}

/** Pure: no clock, no database. Weekdays and hours are UTC. */
export function analyze(rows: PerfRow[]): Analysis {
  const m = rows.filter(measured);
  const platforms = [...new Set(rows.map((r) => r.type))].sort();
  const ranked = [...m].sort((a, b) => reactions(b) - reactions(a) || (b.views ?? 0) - (a.views ?? 0) || b.sent_at - a.sent_at);
  const slotOf = (r: PerfRow): string => { const h = new Date(r.sent_at * 1000).getUTCHours(); const s = Math.floor(h / 3) * 3; return `${String(s).padStart(2, '0')}-${String(s + 3).padStart(2, '0')} UTC`; };
  return {
    total: rows.length,
    measured: m.length,
    byPlatform: platforms.map((p) => {
      const mine = rows.filter((r) => r.type === p), mm = mine.filter(measured);
      return { platform: p, posts: mine.length, measured: mm.length, avgReactions: avg(mm.map(reactions)), views: mm.reduce((a, r) => a + (r.views ?? 0), 0) };
    }),
    top: ranked.slice(0, 3),
    bottom: ranked.length >= 6 ? ranked.slice(-3).reverse() : [],
    byWeekday: buckets(m, (r) => WEEKDAYS[new Date(r.sent_at * 1000).getUTCDay()], ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']),
    bySlot: buckets(m, slotOf, Array.from({ length: 8 }, (_, i) => `${String(i * 3).padStart(2, '0')}-${String(i * 3 + 3).padStart(2, '0')} UTC`)),
    byLength: buckets(m, (r) => (r.len < 100 ? 'short (under 100 chars)' : r.len <= 220 ? 'medium (100-220)' : 'long (over 220)'), ['short (under 100 chars)', 'medium (100-220)', 'long (over 220)']),
    byMedia: buckets(m, (r) => (r.has_media ? 'with media' : 'text only'), ['with media', 'text only']),
    enough: m.length >= ENOUGH_MEASURED,
  };
}

const line = (b: Bucket): string => `  ${b.label}: ${fmt(b.avg)} reactions on average (${b.n} ${b.n === 1 ? 'post' : 'posts'})`;
const quote = (r: PerfRow): string => `"${r.snippet.replace(/\s+/g, ' ').trim()}"`;

/** The text the assistant receives. Plain facts with their sample sizes; the advice is the assistant's job. */
export function renderAnalysis(a: Analysis, days: number): string {
  if (!a.total) return `No posts were sent in the last ${days} days, so there is nothing to analyse yet.`;
  const out: string[] = [`Last ${days} days: ${a.total} sent ${a.total === 1 ? 'post' : 'posts'} (one per channel), ${a.measured} with measured results. "Reactions" = likes + replies + reposts.`];
  if (!a.measured) {
    out.push('No results are measured yet. Vane reads them from the networks a few minutes after publishing and again later, and not every network shares them. Do not invent numbers; say that results are still being collected.');
    return out.join('\n');
  }
  out.push('', 'By network:');
  for (const p of a.byPlatform) out.push(`  ${p.platform}: ${p.posts} posts, ${p.measured} measured, ${fmt(p.avgReactions)} reactions on average, ${p.views} views in total`);
  out.push('', 'Best posts:');
  a.top.forEach((r, i) => out.push(`  ${i + 1}. ${fmt(reactions(r))} reactions, ${r.views ?? '?'} views, ${r.type}: ${quote(r)}`));
  if (a.bottom.length) {
    out.push('', 'Weakest posts:');
    a.bottom.forEach((r, i) => out.push(`  ${i + 1}. ${fmt(reactions(r))} reactions, ${r.views ?? '?'} views, ${r.type}: ${quote(r)}`));
  }
  const sections: [string, Bucket[]][] = [['Day of the week (UTC)', a.byWeekday], ['Time of day (UTC)', a.bySlot], ['Length', a.byLength], ['Media', a.byMedia]];
  for (const [title, bs] of sections) if (bs.length > 1) out.push('', `${title}:`, ...bs.map(line));
  out.push('', a.enough
    ? 'Enough measured posts for patterns, but they describe THIS account only and correlation is not proof: suggest tests, not rules.'
    : `Only ${a.measured} measured ${a.measured === 1 ? 'post' : 'posts'} (patterns need about ${ENOUGH_MEASURED}): treat the buckets above as anecdotes and say so.`);
  return out.join('\n');
}

// ───────────────────────── a series: when does each post go out

export interface SeriesPost { text: string; at?: number }

/**
 * Pure. Picks the time of every post of a series.
 *  - a post with its own time keeps it;
 *  - the others, in order: from `start` every `everySeconds`, else (when `slots` has enough) the best free slots, else every
 *    `everySeconds` from a couple of minutes from now.
 * Every time must be at least a minute ahead and within a year; the first that is not makes the whole plan fail, so nothing is half made.
 */
export function planSeriesTimes(posts: SeriesPost[], o: { now: number; start?: number; everySeconds: number; slots: number[] }): { times: number[] } | { error: string } {
  const loose = posts.filter((p) => p.at === undefined).length;
  const useSlots = o.start === undefined && o.slots.length >= loose;
  let k = 0;
  const times = posts.map((p) => {
    if (p.at !== undefined) return p.at;
    const i = k++;
    if (o.start !== undefined) return o.start + i * o.everySeconds;
    if (useSlots) return o.slots[i];
    return o.now + 120 + i * o.everySeconds;
  });
  for (let i = 0; i < times.length; i++) {
    if (!Number.isFinite(times[i])) return { error: `Post ${i + 1} has no usable time.` };
    if (times[i] < o.now + MIN_LEAD_SECONDS) return { error: `Post ${i + 1} would go out in the past or in under a minute (${new Date(times[i] * 1000).toISOString()}). Give later times.` };
    if (times[i] > o.now + MAX_AHEAD_SECONDS) return { error: `Post ${i + 1} is more than a year ahead (${new Date(times[i] * 1000).toISOString()}). Vane schedules at most one year ahead.` };
  }
  return { times: times.map((t) => Math.floor(t)) };
}
