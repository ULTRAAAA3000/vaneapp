/**
 * Analytics → Activity: what Vane itself did for the user. Built ONLY from the user's own rows (posts, channels), so it works for every
 * network, including the ones that give no numbers back (LinkedIn, Threads, Discord, Reddit, Facebook, Pinterest, Webhook). No third-party call, no new table.
 *
 * "When it happened" = sent_at for a sent post and scheduled_at for a failed one (a failed post has no sent_at).
 */
import type { Env } from '../../../types';
import { UUID_RE } from './http';

export interface ActivityFilter { userId: string; since: number; until: number; channels: string[] }

const TS = `(CASE WHEN p.status = 'sent' THEN p.sent_at ELSE p.scheduled_at END)`;
const DAY = 86400;

function where(f: ActivityFilter): { sql: string; args: unknown[] } {
  const args: unknown[] = [f.userId, f.since, f.until];
  let sql = `p.user_id = ?1 AND p.status IN ('sent', 'failed') AND ${TS} >= ?2 AND ${TS} < ?3`;
  if (f.channels.length) { sql += ` AND p.channel_id IN (${f.channels.map((_, i) => `?${args.length + i + 1}`).join(',')})`; args.push(...f.channels); }
  else sql += ' AND 0';
  return { sql, args };
}

export interface ActivityTotals { sent: number; failed: number; media: number; avgLen: number | null }

export async function activityTotals(env: Env, f: ActivityFilter): Promise<ActivityTotals> {
  const w = where(f);
  const r = await env.DB
    .prepare(
      `SELECT COALESCE(SUM(p.status = 'sent'), 0) sent, COALESCE(SUM(p.status = 'failed'), 0) failed,
              COALESCE(SUM(p.status = 'sent' AND p.media_keys <> '[]'), 0) media,
              AVG(CASE WHEN p.status = 'sent' THEN length(p.content) END) avgLen
         FROM posts p WHERE ${w.sql}`,
    )
    .bind(...w.args)
    .first<ActivityTotals>();
  return r ? { ...r, avgLen: r.avgLen === null ? null : Math.round(r.avgLen) } : { sent: 0, failed: 0, media: 0, avgLen: null };
}

/** Posts still waiting to go out on the chosen channels (not limited to the period). */
export async function activityUpcoming(env: Env, userId: string, channels: string[]): Promise<number> {
  if (!channels.length) return 0;
  const r = await env.DB
    .prepare(`SELECT COUNT(*) n FROM posts p WHERE p.user_id = ?1 AND p.status IN ('scheduled', 'processing') AND p.channel_id IN (${channels.map((_, i) => `?${i + 2}`).join(',')})`)
    .bind(userId, ...channels)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

export async function activityDaily(env: Env, f: ActivityFilter): Promise<{ day: string; sent: number; failed: number }[]> {
  const w = where(f);
  const { results } = await env.DB
    .prepare(`SELECT date(${TS}, 'unixepoch') day, SUM(p.status = 'sent') sent, SUM(p.status = 'failed') failed FROM posts p WHERE ${w.sql} GROUP BY day ORDER BY day`)
    .bind(...w.args)
    .all<{ day: string; sent: number; failed: number }>();
  return results;
}

export interface ActivityChannel { channel_id: string; type: string; name: string; sent: number; failed: number; media: number }

export async function activityByChannel(env: Env, f: ActivityFilter): Promise<ActivityChannel[]> {
  const w = where(f);
  const { results } = await env.DB
    .prepare(
      `SELECT p.channel_id, c.type, c.name, SUM(p.status = 'sent') sent, SUM(p.status = 'failed') failed, SUM(p.status = 'sent' AND p.media_keys <> '[]') media
         FROM posts p JOIN channels c ON c.id = p.channel_id WHERE ${w.sql} GROUP BY p.channel_id ORDER BY sent DESC, failed DESC`,
    )
    .bind(...w.args)
    .all<ActivityChannel>();
  return results;
}

/** Every day of a window as 'YYYY-MM-DD' strings (UTC), so a chart has a point for days with nothing. */
export const dayList = (since: number, until: number): string[] => {
  const out: string[] = [];
  for (let t = Math.floor(since / DAY) * DAY; t < until; t += DAY) out.push(new Date(t * 1000).toISOString().slice(0, 10));
  return out;
};

/** Days in a row, ending today (or yesterday while today is still empty), with at least one sent post; plus the longest run in the window. */
export function streaks(daily: { day: string; sent: number }[], now: number): { current: number; longest: number; activeDays: number } {
  const active = new Set(daily.filter((d) => d.sent > 0).map((d) => d.day));
  const iso = (t: number): string => new Date(t * 1000).toISOString().slice(0, 10);
  let cursor = Math.floor(now / DAY) * DAY;
  if (!active.has(iso(cursor))) cursor -= DAY;
  let current = 0;
  while (active.has(iso(cursor))) { current++; cursor -= DAY; }
  let longest = 0, run = 0, prev = '';
  for (const d of [...active].sort()) {
    run = prev && Date.parse(d) - Date.parse(prev) === DAY * 1000 ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = d;
  }
  return { current, longest, activeDays: active.size };
}

/** Sent posts per weekday × 3-hour slot in the user's own time zone (when the user publishes, not how well it works). */
export async function activityHabits(env: Env, f: ActivityFilter, timeZone: string): Promise<number[][]> {
  const w = where(f);
  const { results } = await env.DB
    .prepare(`SELECT p.sent_at FROM posts p WHERE ${w.sql} AND p.status = 'sent' ORDER BY p.sent_at DESC LIMIT 5000`)
    .bind(...w.args)
    .all<{ sent_at: number }>();
  const opts = { weekday: 'short', hour: 'numeric', hourCycle: 'h23' } as const;
  let fmt: Intl.DateTimeFormat;
  try { fmt = new Intl.DateTimeFormat('en-US', { timeZone, ...opts }); } catch { fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...opts }); }
  const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const grid = Array.from({ length: 7 }, () => Array<number>(8).fill(0));
  for (const r of results) {
    const parts = fmt.formatToParts(new Date(r.sent_at * 1000));
    const d = names.indexOf(parts.find((p) => p.type === 'weekday')?.value ?? '');
    const h = Number(parts.find((p) => p.type === 'hour')?.value ?? -1);
    if (d >= 0 && h >= 0) grid[d][Math.floor(h / 3)]++;
  }
  return grid;
}

/** A failure text without the parts that differ every time (links, ids, long numbers), so equal causes are counted together. */
export function reasonOf(error: string | null): string {
  const s = (error ?? '')
    .replace(/https?:\/\/\S+/gi, '<link>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/\d{4,}/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 110);
  return s || 'No reason was recorded';
}

export async function activityFailures(env: Env, f: ActivityFilter): Promise<{ reason: string; count: number; last: number }[]> {
  const w = where(f);
  const { results } = await env.DB
    .prepare(`SELECT p.error, ${TS} AS ts FROM posts p WHERE ${w.sql} AND p.status = 'failed' ORDER BY ts DESC LIMIT 1000`)
    .bind(...w.args)
    .all<{ error: string | null; ts: number }>();
  const groups = new Map<string, { reason: string; count: number; last: number }>();
  for (const r of results) {
    const reason = reasonOf(r.error);
    const g = groups.get(reason);
    if (g) g.count++; else groups.set(reason, { reason, count: 1, last: r.ts });
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || b.last - a.last).slice(0, 5);
}

/** How close to the scheduled minute the posts really went out. */
export async function activityPunctuality(env: Env, f: ActivityFilter): Promise<{ n: number; onTimePct: number | null; avgSec: number | null; p95Sec: number | null }> {
  const w = where(f);
  const { results } = await env.DB
    .prepare(`SELECT p.sent_at - p.scheduled_at AS delay FROM posts p WHERE ${w.sql} AND p.status = 'sent' AND p.sent_at IS NOT NULL ORDER BY p.sent_at DESC LIMIT 5000`)
    .bind(...w.args)
    .all<{ delay: number }>();
  const d = results.map((r) => Math.max(0, r.delay)).sort((a, b) => a - b);
  if (!d.length) return { n: 0, onTimePct: null, avgSec: null, p95Sec: null };
  const avg = d.reduce((a, b) => a + b, 0) / d.length;
  return {
    n: d.length,
    onTimePct: Math.round((d.filter((x) => x <= 120).length / d.length) * 100),
    avgSec: Math.round(avg),
    p95Sec: d[Math.min(d.length - 1, Math.ceil(d.length * 0.95) - 1)],
  };
}

/** Rows for the Activity CSV: one line per day and channel. */
export async function activityRows(env: Env, f: ActivityFilter): Promise<{ day: string; type: string; name: string; sent: number; failed: number }[]> {
  const w = where(f);
  const { results } = await env.DB
    .prepare(
      `SELECT date(${TS}, 'unixepoch') day, c.type, c.name, SUM(p.status = 'sent') sent, SUM(p.status = 'failed') failed
         FROM posts p JOIN channels c ON c.id = p.channel_id WHERE ${w.sql} GROUP BY day, p.channel_id ORDER BY day, c.name`,
    )
    .bind(...w.args)
    .all<{ day: string; type: string; name: string; sent: number; failed: number }>();
  return results;
}

/** channels=all (or nothing) → every channel of the user; ids → only the user's own ones. Unlike the results tabs, every network counts here. */
export function pickActivityChannels(param: string | null, owned: { id: string }[]): string[] {
  const mine = new Set(owned.map((c) => c.id));
  const asked = (param ?? '').split(',').map((s) => s.trim()).filter((s) => UUID_RE.test(s) && mine.has(s));
  return asked.length && param !== 'all' ? [...new Set(asked)].slice(0, 50) : owned.map((c) => c.id);
}
