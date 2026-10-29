import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { requireUser } from '../lib/auth';
import { FREE_DAYS, followerSeries, isAnalyticsPro, PRO_DAYS } from '../lib/analyticsdata';
import { FREE_PAGE, listChannels, pickChannels, PRO_PAGE, queryDaily, queryPosts, queryTotals, SORTS, type Filter, type Sort } from '../lib/analyticsquery';
import { json, methodNotAllowed } from '../lib/http';
import { nowSeconds } from '../lib/usage';

const dayOf = (t: number): string => new Date(t * 1000).toISOString().slice(0, 10);

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  const url = new URL(request.url);
  const now = nowSeconds();
  const pro = await isAnalyticsPro(env, auth.userId, now);
  const maxDays = pro ? PRO_DAYS : FREE_DAYS;
  const asked = Number(url.searchParams.get('days'));
  const days = Number.isInteger(asked) && asked >= 7 ? Math.min(asked, maxDays) : Math.min(30, maxDays);
  const since = now - days * 86400;
  const sortParam = url.searchParams.get('sort') as Sort;
  const sort: Sort = SORTS.includes(sortParam) ? sortParam : 'new';
  const pageSize = pro ? PRO_PAGE : FREE_PAGE;
  const page = pro ? Math.max(1, Math.min(500, Number(url.searchParams.get('page')) || 1)) : 1;
  const q = pro ? (url.searchParams.get('q') ?? '').trim().slice(0, 80) : '';
  const base = { pro, days, maxDays, pageSize, sort };
  try {
    const channels = await listChannels(env, auth.userId, dayOf(since));
    const selected = pickChannels(url.searchParams.get('channels'), channels);
    const f: Filter = { userId: auth.userId, since, channels: selected, q };
    const [totals, daily, posts, top] = await Promise.all([queryTotals(env, f), queryDaily(env, f), queryPosts(env, f, sort, pageSize, (page - 1) * pageSize), queryPosts(env, f, 'reactions', 3, 0)]);
    const series = pro && selected.length ? (await followerSeries(env, auth.userId, dayOf(since))).filter((p) => selected.includes(p.channel_id)) : [];
    return json({ ok: true, ...base, page, channels, selected, totals, daily, posts: posts.items, postsTotal: posts.total, top: top.items.filter((x) => (x.likes ?? 0) + (x.replies ?? 0) + (x.reposts ?? 0) > 0), series });
  } catch {
    return json({ ok: true, ...base, page: 1, channels: [], selected: [], totals: { posts: 0, views: 0, likes: 0, replies: 0, reposts: 0 }, daily: [], posts: [], postsTotal: 0, top: [], series: [] });
  }
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET');
