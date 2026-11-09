import type { Env } from '../../../types';
import { isValidMediaUrl } from '../channels/telegram';
import { insertPostGroup, settleUiQuota, takeUiQuota, uiChargeLog, validateCreatePost, CONTENT_LIMIT } from '../posts/create';
import { disabledModules } from './modules';
import { postUnits } from './plans';
import { graphemeLength, mastodonLength, threadsLength } from './text';
import { publicHttpsUrl } from './netsafe';

export const FEEDS_FREE = 1;
export const FEEDS_PAID = 10;
export const feedLimit = (plan: string): number => (plan === 'free' ? FEEDS_FREE : FEEDS_PAID);

export const POLL_SECONDS = 30 * 60;
export const MAX_FEED_BYTES = 1_000_000;
export const MAX_NEW_PER_POLL = 3;
export const STALE_SECONDS = 3 * 24 * 3600;
export const MAX_FAILS = 20;
export const DEFAULT_TEMPLATE = '{title}\n\n{link}';
export const TEMPLATE_MAX = 500;
export const DELAY_MIN = 1;
export const DELAY_MAX = 24 * 60;
const DUE_BATCH = 20;

export interface FeedItem { guid: string; title: string; link: string; summary: string; image: string | null; at: number | null }
export interface ParsedFeed { title: string; items: FeedItem[] }

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function text(raw: string): string {
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(raw);
  const inner = cdata ? cdata[1] : decode(raw);
  return decode(inner.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function tag(block: string, name: string): string | null {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block);
  return m ? m[1] : null;
}

function attr(tagText: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tagText);
  return m ? decode(m[2] ?? m[3] ?? '') : null;
}

function atomLink(block: string): string {
  const links = [...block.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);
  const pick = links.find((l) => (attr(l, 'rel') ?? 'alternate') === 'alternate' && attr(l, 'href')) ?? links.find((l) => attr(l, 'href'));
  return pick ? (attr(pick, 'href') ?? '') : '';
}

function imageOf(block: string): string | null {
  for (const m of block.matchAll(/<(?:media:content|media:thumbnail|enclosure|link)\b[^>]*>/gi)) {
    const t = m[0];
    const url = attr(t, 'url') ?? (/^<link/i.test(t) && (attr(t, 'rel') ?? '') === 'enclosure' ? attr(t, 'href') : null);
    if (!url) continue;
    const type = (attr(t, 'type') ?? '').toLowerCase();
    const medium = (attr(t, 'medium') ?? '').toLowerCase();
    if (type.startsWith('image/') || medium === 'image' || /^<media:thumbnail/i.test(t) || (!type && !medium && /\.(jpe?g|png|gif|webp)(\?|$)/i.test(url))) return url;
  }
  const html = /<img\b[^>]*\ssrc\s*=\s*["']([^"']+)["']/i.exec(decode(tag(block, 'content:encoded') ?? tag(block, 'description') ?? tag(block, 'content') ?? ''));
  return html ? html[1] : null;
}

function when(block: string): number | null {
  const raw = tag(block, 'pubDate') ?? tag(block, 'published') ?? tag(block, 'updated') ?? tag(block, 'dc:date');
  if (!raw) return null;
  const ms = Date.parse(text(raw));
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

export function parseFeed(xml: string): ParsedFeed | null {
  const body = xml.replace(/<!--[\s\S]*?-->/g, '');
  const atom = /<feed\b/i.test(body);
  if (!atom && !/<rss\b|<rdf:RDF\b/i.test(body)) return null;
  const blocks = [...body.matchAll(atom ? /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi : /<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map((m) => m[1]);
  const head = body.slice(0, body.search(atom ? /<entry\b/i : /<item\b/i) >= 0 ? body.search(atom ? /<entry\b/i : /<item\b/i) : body.length);
  const title = text(tag(head, 'title') ?? '').slice(0, 200);
  const items: FeedItem[] = [];
  for (const b of blocks) {
    const link = (atom ? atomLink(b) : text(tag(b, 'link') ?? '')).trim();
    const itemTitle = text(tag(b, 'title') ?? '');
    const id = text(tag(b, atom ? 'id' : 'guid') ?? '');
    const guid = (id || link || itemTitle).slice(0, 500);
    if (!guid) continue;
    const summary = text(tag(b, 'description') ?? tag(b, 'summary') ?? tag(b, 'content:encoded') ?? tag(b, 'content') ?? '');
    items.push({ guid, title: itemTitle, link, summary, image: imageOf(b), at: when(b) });
  }
  const seen = new Set<string>();
  const unique = items.filter((i) => (seen.has(i.guid) ? false : (seen.add(i.guid), true)));
  if (unique.length && unique.every((i) => i.at !== null)) unique.sort((a, b) => (b.at as number) - (a.at as number));
  return { title, items: unique };
}

export function templateProblem(t: unknown): string | null {
  if (typeof t !== 'string' || !t.trim()) return 'The post template is empty.';
  if (t.length > TEMPLATE_MAX) return `The post template can be at most ${TEMPLATE_MAX} characters.`;
  if (!/\{(title|link|summary)\}/.test(t)) return 'The post template needs at least one of {title}, {link} or {summary}.';
  return null;
}

const render = (t: string, title: string, link: string, summary: string): string =>
  t.replace(/\{title\}/g, title).replace(/\{link\}/g, link).replace(/\{summary\}/g, summary).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

const lengthFor = (type: string, s: string): number =>
  type === 'bluesky' ? graphemeLength(s) : type === 'mastodon' ? mastodonLength(s) : type === 'threads' ? threadsLength(s) : s.length;

const fits = (s: string, types: string[]): boolean => types.every((t) => lengthFor(t, s) <= (CONTENT_LIMIT as Record<string, number>)[t] && (t !== 'bluesky' || new TextEncoder().encode(s).length <= 3000));

const cut = (s: string, n: number): string => {
  const chars = Array.from(s);
  return chars.length <= n ? s : `${chars.slice(0, Math.max(0, n - 1)).join('').trimEnd()}…`;
};

export function fitPost(template: string, item: Pick<FeedItem, 'title' | 'link' | 'summary'>, types: string[]): string | null {
  const full = render(template, item.title, item.link, item.summary);
  if (fits(full, types)) return full;
  const shrink = (title: string, summary: string, limit: number, which: 'summary' | 'title'): string | null => {
    let lo = 0, hi = limit, best: string | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = which === 'summary' ? render(template, title, item.link, cut(summary, mid)) : render(template, cut(title, mid), item.link, summary);
      if (fits(s, types)) { best = s; lo = mid + 1; } else hi = mid - 1;
    }
    return best;
  };
  const noSummary = render(template, item.title, item.link, '');
  if (fits(noSummary, types)) return shrink(item.title, item.summary, Array.from(item.summary).length, 'summary');
  const bare = render(template, '', item.link, '');
  if (!fits(bare, types)) return null;
  return shrink(item.title, '', Array.from(item.title).length, 'title');
}

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export type Fetched =
  | { ok: true; notModified: true }
  | { ok: true; notModified: false; feed: ParsedFeed; etag: string | null; lastModified: string | null }
  | { ok: false; error: string };

async function readCapped(res: Response): Promise<string | null> {
  if (!res.body) return (await res.text()).length > MAX_FEED_BYTES ? null : await res.text();
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_FEED_BYTES) { await reader.cancel().catch(() => undefined); return null; }
    parts.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { all.set(p, at); at += p.byteLength; }
  return new TextDecoder('utf-8').decode(all);
}

export async function fetchFeed(url: string, cond: { etag?: string | null; lastModified?: string | null } = {}, doFetch: FetchFn = (u, i) => fetch(u, i)): Promise<Fetched> {
  const start = publicHttpsUrl(url);
  if (!start) return { ok: false, error: 'The feed address must be a public https link.' };
  let current: string = start;
  const headers: Record<string, string> = { 'User-Agent': 'VaneFeedBot/1.0 (+https://vaneapp.dev)', Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5' };
  if (cond.etag) headers['If-None-Match'] = cond.etag;
  if (cond.lastModified) headers['If-Modified-Since'] = cond.lastModified;
  for (let hop = 0; hop < 4; hop++) {
    let res: Response;
    try {
      res = await doFetch(current, { headers, redirect: 'manual', signal: AbortSignal.timeout(8000) });
    } catch {
      return { ok: false, error: 'The feed could not be reached.' };
    }
    if (res.status === 304) return { ok: true, notModified: true };
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      const next: string | null = loc ? publicHttpsUrl(new URL(loc, current).toString()) : null;
      if (!next) return { ok: false, error: 'The feed redirects somewhere that is not allowed.' };
      current = next;
      continue;
    }
    if (!res.ok) return { ok: false, error: `The feed answered with HTTP ${res.status}.` };
    const xml = await readCapped(res);
    if (xml === null) return { ok: false, error: 'The feed is larger than 1 MB.' };
    const feed = parseFeed(xml);
    if (!feed) return { ok: false, error: 'This address is not an RSS or Atom feed.' };
    return { ok: true, notModified: false, feed, etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified') };
  }
  return { ok: false, error: 'The feed redirects too many times.' };
}

export interface FeedRow {
  id: string; user_id: string; url: string; title: string | null; channel_ids: string; template: string; delay_minutes: number;
  enabled: number; baselined: number; etag: string | null; last_modified: string | null; fail_count: number; posted_count: number;
}

const claimItem = async (env: Env, feedId: string, guid: string, now: number): Promise<boolean> =>
  ((await env.DB.prepare('INSERT OR IGNORE INTO feed_items (feed_id, guid, created_at) VALUES (?1, ?2, ?3)').bind(feedId, guid, now).run()).meta.changes ?? 0) > 0;

const unclaimItem = (env: Env, feedId: string, guid: string) =>
  env.DB.prepare('DELETE FROM feed_items WHERE feed_id = ?1 AND guid = ?2').bind(feedId, guid).run();

async function postItem(env: Env, feed: FeedRow, item: FeedItem, channelIds: string[], now: number): Promise<{ status: 'posted' } | { status: 'skipped'; error: string } | { status: 'blocked'; error: string } | { status: 'gone'; error: string }> {
  const channels = (await env.DB
    .prepare(`SELECT id, type FROM channels WHERE user_id = ?1 AND is_active = 1 AND id IN (${channelIds.map((_, i) => `?${i + 2}`).join(',')})`)
    .bind(feed.user_id, ...channelIds).all<{ id: string; type: string }>()).results;
  if (!channels.length) return { status: 'gone', error: 'None of the selected channels is connected any more.' };

  const content = fitPost(feed.template, item, channels.map((c) => c.type));
  if (!content) return { status: 'skipped', error: `"${item.title.slice(0, 60)}" does not fit the selected networks.` };

  const scheduledAt = now + Math.max(DELAY_MIN, feed.delay_minutes) * 60;
  const attempt = async (mediaUrl: string | null) => validateCreatePost(env, feed.user_id, { content, mediaUrl, channelIds: channels.map((c) => c.id), scheduledAt });
  const withImage = item.image && isValidMediaUrl(item.image) ? item.image : null;
  let checked = await attempt(withImage);
  if (!checked.ok && withImage) checked = await attempt(null);
  if (!checked.ok) {
    const msg = ((await checked.response.json().catch(() => ({}))) as { error?: string }).error ?? 'The post was refused.';
    return { status: 'skipped', error: `"${item.title.slice(0, 60)}": ${msg}` };
  }

  const units = postUnits(checked.v.channels.length);
  const quota = await takeUiQuota(env, feed.user_id, units);
  if (!quota.ok) {
    const msg = ((await quota.response.json().catch(() => ({}))) as { error?: string }).error ?? 'Your plan has no posts left.';
    return { status: 'blocked', error: msg };
  }
  const saved = await insertPostGroup(env, feed.user_id, checked.v, uiChargeLog(env, feed.user_id, quota.reservation, units));
  await settleUiQuota(env, feed.user_id, quota.reservation, units, saved.ok);
  return saved.ok ? { status: 'posted' } : { status: 'blocked', error: 'Could not schedule the post.' };
}

export async function pollFeed(env: Env, feed: FeedRow, now: number, doFetch?: FetchFn): Promise<void> {
  const fetched = await fetchFeed(feed.url, { etag: feed.etag, lastModified: feed.last_modified }, doFetch);
  const wait = (fails: number) => Math.min(POLL_SECONDS * 2 ** Math.min(fails, 4), 6 * 3600);

  if (!fetched.ok) {
    const fails = feed.fail_count + 1;
    await env.DB.prepare('UPDATE feeds SET fail_count = ?2, last_error = ?3, last_checked_at = ?4, next_check_at = ?5, enabled = ?6 WHERE id = ?1')
      .bind(feed.id, fails, fetched.error, now, now + wait(fails), fails >= MAX_FAILS ? 0 : feed.enabled).run();
    return;
  }
  if (fetched.notModified) {
    await env.DB.prepare('UPDATE feeds SET fail_count = 0, last_error = NULL, last_checked_at = ?2, next_check_at = ?3 WHERE id = ?1').bind(feed.id, now, now + POLL_SECONDS).run();
    return;
  }

  const items = fetched.feed.items;
  let lastError: string | null = null;
  let posted = 0;
  let enabled = feed.enabled;
  let nextAt = now + POLL_SECONDS;

  if (!feed.baselined) {
    if (items.length) await env.DB.batch(items.map((i) => env.DB.prepare('INSERT OR IGNORE INTO feed_items (feed_id, guid, created_at) VALUES (?1, ?2, ?3)').bind(feed.id, i.guid, now)));
  } else {
    const fresh: FeedItem[] = [];
    for (const i of items) {
      const known = await env.DB.prepare('SELECT 1 AS x FROM feed_items WHERE feed_id = ?1 AND guid = ?2').bind(feed.id, i.guid).first();
      if (!known) fresh.push(i);
    }
    const current = fresh.filter((i) => i.at === null || now - i.at <= STALE_SECONDS);
    const toPost = current.slice(0, MAX_NEW_PER_POLL).reverse();
    const dropped = fresh.filter((i) => !toPost.includes(i));
    if (dropped.length) await env.DB.batch(dropped.map((i) => env.DB.prepare('INSERT OR IGNORE INTO feed_items (feed_id, guid, created_at) VALUES (?1, ?2, ?3)').bind(feed.id, i.guid, now)));

    let channelIds: string[] = [];
    try { channelIds = (JSON.parse(feed.channel_ids) as unknown[]).filter((x): x is string => typeof x === 'string'); } catch { channelIds = []; }

    for (const item of toPost) {
      if (!(await claimItem(env, feed.id, item.guid, now))) continue;
      const r = await postItem(env, feed, item, channelIds, now);
      if (r.status === 'posted') { posted++; continue; }
      lastError = r.error;
      if (r.status === 'blocked') { await unclaimItem(env, feed.id, item.guid); nextAt = now + POLL_SECONDS; break; }
      if (r.status === 'gone') { enabled = 0; break; }
    }
  }

  await env.DB.prepare(
    `UPDATE feeds SET title = COALESCE(NULLIF(?2, ''), title), etag = ?3, last_modified = ?4, baselined = 1, fail_count = 0, last_error = ?5,
       last_checked_at = ?6, next_check_at = ?7, posted_count = posted_count + ?8, enabled = ?9 WHERE id = ?1`,
  ).bind(feed.id, fetched.feed.title, fetched.etag, fetched.lastModified, lastError, now, nextAt, posted, enabled).run();
  await env.DB.prepare('DELETE FROM feed_items WHERE feed_id = ?1 AND guid NOT IN (SELECT guid FROM feed_items WHERE feed_id = ?1 ORDER BY created_at DESC LIMIT 2000)').bind(feed.id).run();
}

export async function runFeeds(env: Env, now: number, doFetch?: FetchFn): Promise<number> {
  if ((await disabledModules(env)).includes('feeds')) return 0;
  let rows: FeedRow[];
  try {
    rows = (await env.DB.prepare('SELECT * FROM feeds WHERE enabled = 1 AND next_check_at <= ?1 ORDER BY next_check_at LIMIT ?2').bind(now, DUE_BATCH).all<FeedRow>()).results;
  } catch (err) {
    if (/no such table/i.test(err instanceof Error ? err.message : '')) return 0;
    throw err;
  }
  let polled = 0;
  for (const feed of rows) {
    const claim = await env.DB.prepare('UPDATE feeds SET next_check_at = ?2 WHERE id = ?1 AND enabled = 1 AND next_check_at <= ?3').bind(feed.id, now + POLL_SECONDS, now).run();
    if (!claim.meta.changes) continue;
    try { await pollFeed(env, feed, now, doFetch); polled++; } catch (err) { console.error('feed poll failed:', err instanceof Error ? err.message : 'unknown'); }
  }
  return polled;
}
