import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { requireUser } from '../lib/auth';
import { DEFAULT_TEMPLATE, DELAY_MAX, DELAY_MIN, feedLimit, fetchFeed, POLL_SECONDS, templateProblem } from '../lib/feeds';
import { feedView, myActiveChannels, readChannelIds, readDelay, type FeedViewRow } from '../lib/feedsapi';
import { fail, failCode, isRecord, json, methodNotAllowed, readJson } from '../lib/http';
import { publicHttpsUrl } from '../lib/netsafe';
import { loadSubscription } from '../lib/usage';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  const limit = feedLimit((await loadSubscription(env, auth.userId)).plan);
  try {
    const { results } = await env.DB.prepare('SELECT * FROM feeds WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 50').bind(auth.userId).all<FeedViewRow>();
    return json({ ok: true, limit, defaultTemplate: DEFAULT_TEMPLATE, items: results.map(feedView) });
  } catch {
    return json({ ok: true, limit, defaultTemplate: DEFAULT_TEMPLATE, items: [] });
  }
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  const parsed = await readJson(request, 8192);
  if (!parsed.ok) return parsed.response;
  const b = parsed.data;
  if (!isRecord(b)) return fail(400, 'Body must be a JSON object.');

  const url = publicHttpsUrl(typeof b.url === 'string' ? b.url.trim() : '');
  if (!url) return failCode(400, 'bad_url', 'The feed address must be a public https link.');
  const channelIds = readChannelIds(b.channelIds);
  if (!channelIds) return failCode(400, 'bad_channels', 'Choose at least one channel.');
  const template = b.template === undefined ? DEFAULT_TEMPLATE : b.template;
  const tp = templateProblem(template);
  if (tp) return failCode(400, 'bad_template', tp);
  const delay = b.delayMinutes === undefined ? 30 : readDelay(b.delayMinutes);
  if (delay === null) return failCode(400, 'bad_delay', `The delay must be a whole number of minutes from ${DELAY_MIN} to ${DELAY_MAX}, or 0 to save new items as drafts.`);
  if (!(await myActiveChannels(env, auth.userId, channelIds))) return fail(404, 'One or more channels were not found.');

  const dup = await env.DB.prepare('SELECT 1 AS x FROM feeds WHERE user_id = ?1 AND url = ?2').bind(auth.userId, url).first();
  if (dup) return failCode(409, 'feed_exists', 'You already follow this feed.');

  const limit = feedLimit((await loadSubscription(env, auth.userId)).plan);
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM feeds WHERE user_id = ?1').bind(auth.userId).first<{ n: number }>();
  if ((count?.n ?? 0) >= limit) {
    return failCode(402, 'feed_limit', limit <= 1 ? `The Free Trial can follow ${limit} feed. Remove it, or upgrade for up to 10.` : `You can follow up to ${limit} feeds. Remove one first.`);
  }
  const fetched = await fetchFeed(url, {});
  if (!fetched.ok) return failCode(422, 'feed_unreadable', fetched.error);
  if (fetched.notModified) return failCode(422, 'feed_unreadable', 'The feed gave no content.');

  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO feeds (id, user_id, url, title, channel_ids, template, delay_minutes, enabled, baselined, etag, last_modified, next_check_at, last_checked_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, 1, ?8, ?9, ?10, ?11, ?11)')
      .bind(id, auth.userId, url, fetched.feed.title || null, JSON.stringify(channelIds), template, delay, fetched.etag, fetched.lastModified, now + POLL_SECONDS, now),
    ...fetched.feed.items.map((i) => env.DB.prepare('INSERT OR IGNORE INTO feed_items (feed_id, guid, created_at) VALUES (?1, ?2, ?3)').bind(id, i.guid, now)),
  ]);
  return json({ ok: true, id, title: fetched.feed.title, existingItems: fetched.feed.items.length }, 201);
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET, POST');
