import type { CronEnv } from '../../../types';
import { loadTelegramCreds } from '../channels/credentials';
import { callJson } from './httpcall';
import { publicHttpsUrl } from './netsafe';

export const STAGE_AGES = [3600, 86400, 7 * 86400, 30 * 86400];
export const METRIC_PLATFORMS = ['bluesky', 'mastodon', 'devto'];
export const FOLLOWER_PLATFORMS = ['bluesky', 'mastodon', 'telegram'];

export interface Metrics { views: number | null; likes: number | null; replies: number | null; reposts: number | null }
export type Fetched = { ok: true; m: Metrics } | { ok: false; permanent: boolean };

const count = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);
const gone = (status: number): boolean => status === 404 || status === 410 || status === 400 || status === 401 || status === 403;
const sum = (a: number | null, b: number | null): number | null => (a === null && b === null ? null : (a ?? 0) + (b ?? 0));

const BSKY = 'https://public.api.bsky.app/xrpc';
const BSKY_URI = /^at:\/\/(did:[a-z0-9]+:[A-Za-z0-9._:%-]+)\/app\.bsky\.feed\.post\/[A-Za-z0-9._~:-]+$/;

export async function bskyMetrics(uris: string[]): Promise<Map<string, Fetched>> {
  const out = new Map<string, Fetched>();
  const valid = uris.filter((u) => BSKY_URI.test(u));
  for (const u of uris) if (!valid.includes(u)) out.set(u, { ok: false, permanent: true });
  for (let i = 0; i < valid.length; i += 25) {
    const chunk = valid.slice(i, i + 25);
    const r = await callJson<{ posts?: { uri?: string; likeCount?: number; repostCount?: number; replyCount?: number; quoteCount?: number }[] }>(
      `${BSKY}/app.bsky.feed.getPosts?${chunk.map((u) => `uris=${encodeURIComponent(u)}`).join('&')}`,
    );
    if (!r.ok) { for (const u of chunk) out.set(u, { ok: false, permanent: gone(r.status) }); continue; }
    const seen = new Map((r.data.posts ?? []).map((p) => [p.uri, p]));
    for (const u of chunk) {
      const p = seen.get(u);
      out.set(u, p ? { ok: true, m: { views: null, likes: count(p.likeCount), replies: count(p.replyCount), reposts: sum(count(p.repostCount), count(p.quoteCount)) } } : { ok: false, permanent: true });
    }
  }
  return out;
}

export function mastodonParts(externalId: string): { host: string; id: string; acct: string } | null {
  const safe = publicHttpsUrl(externalId);
  if (!safe) return null;
  const u = new URL(safe);
  const id = /\/(\d{5,25})\/?$/.exec(u.pathname)?.[1];
  const acct = /\/@([A-Za-z0-9_.-]{1,64})\//.exec(u.pathname)?.[1] ?? /\/users\/([A-Za-z0-9_.-]{1,64})\/statuses\//.exec(u.pathname)?.[1];
  return id && acct ? { host: u.hostname, id, acct } : null;
}

export async function mastodonMetrics(externalId: string): Promise<Fetched> {
  const p = mastodonParts(externalId);
  if (!p) return { ok: false, permanent: true };
  const r = await callJson<{ favourites_count?: number; reblogs_count?: number; replies_count?: number }>(`https://${p.host}/api/v1/statuses/${p.id}`);
  if (!r.ok) return { ok: false, permanent: gone(r.status) };
  return { ok: true, m: { views: null, likes: count(r.data.favourites_count), replies: count(r.data.replies_count), reposts: count(r.data.reblogs_count) } };
}

export async function devtoMetrics(externalId: string): Promise<Fetched> {
  const safe = publicHttpsUrl(externalId);
  const u = safe ? new URL(safe) : null;
  const path = u && u.hostname === 'dev.to' ? /^\/([A-Za-z0-9_-]{1,40})\/([A-Za-z0-9_-]{1,200})\/?$/.exec(u.pathname) : null;
  if (!path) return { ok: false, permanent: true };
  const r = await callJson<{ public_reactions_count?: number; comments_count?: number; page_views_count?: number }>(`https://dev.to/api/articles/${path[1]}/${path[2]}`);
  if (!r.ok) return { ok: false, permanent: gone(r.status) };
  return { ok: true, m: { views: count(r.data.page_views_count), likes: count(r.data.public_reactions_count), replies: count(r.data.comments_count), reposts: null } };
}

export const stageOf = (age: number): number => (age >= STAGE_AGES[3] ? 4 : age >= STAGE_AGES[2] ? 3 : age >= STAGE_AGES[1] ? 2 : 1);

interface Due { id: string; type: string; external_id: string; sent_at: number }

export async function collectPostMetrics(env: CronEnv, now: number, limit = 40): Promise<number> {
  const marks = METRIC_PLATFORMS.map((_, i) => `?${i + 3}`).join(',');
  const { results } = await env.DB
    .prepare(
      `SELECT p.id, c.type, p.external_id, p.sent_at
         FROM posts p JOIN channels c ON c.id = p.channel_id
        WHERE p.status = 'sent' AND p.external_id <> '' AND p.sent_at IS NOT NULL AND c.type IN (${marks})
          AND p.sent_at <= ?1 - ${STAGE_AGES[0]} AND p.sent_at > ?1 - ${STAGE_AGES[3] + 3 * 86400}
          AND NOT EXISTS (SELECT 1 FROM post_metrics m WHERE m.post_id = p.id AND m.stage =
                CASE WHEN ?1 - p.sent_at >= ${STAGE_AGES[3]} THEN 4 WHEN ?1 - p.sent_at >= ${STAGE_AGES[2]} THEN 3 WHEN ?1 - p.sent_at >= ${STAGE_AGES[1]} THEN 2 ELSE 1 END)
        ORDER BY p.sent_at ASC LIMIT ?2`,
    )
    .bind(now, limit, ...METRIC_PLATFORMS)
    .all<Due>();
  if (!results.length) return 0;

  const bsky = results.filter((r) => r.type === 'bluesky');
  const bskyOut = bsky.length ? await bskyMetrics(bsky.map((r) => r.external_id)) : new Map<string, Fetched>();
  let saved = 0;
  for (const r of results) {
    const got = r.type === 'bluesky' ? bskyOut.get(r.external_id) ?? { ok: false as const, permanent: true } : r.type === 'mastodon' ? await mastodonMetrics(r.external_id) : await devtoMetrics(r.external_id);
    if (!got.ok && !got.permanent) continue;
    const m: Metrics = got.ok ? got.m : { views: null, likes: null, replies: null, reposts: null };
    await env.DB
      .prepare('INSERT OR REPLACE INTO post_metrics (post_id, stage, taken_at, views, likes, replies, reposts) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
      .bind(r.id, stageOf(now - r.sent_at), now, m.views, m.likes, m.replies, m.reposts)
      .run();
    saved++;
  }
  return saved;
}

const dayOf = (now: number): string => new Date(now * 1000).toISOString().slice(0, 10);

async function followersOf(env: CronEnv, ch: { id: string; type: string; credentials: string }, last: string | null): Promise<number | null> {
  if (ch.type === 'telegram') {
    const loaded = await loadTelegramCreds(ch.credentials, env);
    if (!loaded.ok) return null;
    const r = await callJson<{ ok?: boolean; result?: number }>(`https://api.telegram.org/bot${loaded.creds.botToken}/getChatMemberCount?chat_id=${encodeURIComponent(loaded.creds.chatId)}`);
    return r.ok && r.data.ok ? count(r.data.result) : null;
  }
  if (!last) return null;
  if (ch.type === 'bluesky') {
    const did = BSKY_URI.exec(last)?.[1];
    if (!did) return null;
    const r = await callJson<{ followersCount?: number }>(`${BSKY}/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`);
    return r.ok ? count(r.data.followersCount) : null;
  }
  const p = mastodonParts(last);
  if (!p) return null;
  const r = await callJson<{ followers_count?: number }>(`https://${p.host}/api/v1/accounts/lookup?acct=${encodeURIComponent(p.acct)}`);
  return r.ok ? count(r.data.followers_count) : null;
}

export async function collectFollowers(env: CronEnv, now: number, limit = 20): Promise<number> {
  const day = dayOf(now);
  const marks = FOLLOWER_PLATFORMS.map((_, i) => `?${i + 3}`).join(',');
  const { results } = await env.DB
    .prepare(
      `SELECT c.id, c.type, c.credentials,
              (SELECT p.external_id FROM posts p WHERE p.channel_id = c.id AND p.status = 'sent' AND p.external_id <> '' ORDER BY p.sent_at DESC LIMIT 1) AS last
         FROM channels c
        WHERE c.is_active = 1 AND c.type IN (${marks})
          AND NOT EXISTS (SELECT 1 FROM channel_followers f WHERE f.channel_id = c.id AND f.day = ?1)
        LIMIT ?2`,
    )
    .bind(day, limit, ...FOLLOWER_PLATFORMS)
    .all<{ id: string; type: string; credentials: string; last: string | null }>();
  let saved = 0;
  for (const ch of results) {
    const n = await followersOf(env, ch, ch.last).catch(() => null);
    if (n === null) continue;
    await env.DB.prepare('INSERT OR REPLACE INTO channel_followers (channel_id, day, followers) VALUES (?1, ?2, ?3)').bind(ch.id, day, n).run();
    saved++;
  }
  return saved;
}

export async function purgeOldMetrics(env: CronEnv, now: number): Promise<void> {
  await env.DB.prepare('DELETE FROM post_metrics WHERE taken_at < ?1').bind(now - 400 * 86400).run();
  await env.DB.prepare('DELETE FROM channel_followers WHERE day < ?1').bind(dayOf(now - 400 * 86400)).run();
}
