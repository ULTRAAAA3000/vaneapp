import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { requireUser } from '../lib/auth';
import { FREE_DAYS, FREE_POSTS, followerSeries, followerSummary, isAnalyticsPro, listPostResults, PRO_DAYS } from '../lib/analyticsdata';
import { json, methodNotAllowed } from '../lib/http';
import { nowSeconds } from '../lib/usage';

const dayOf = (t: number): string => new Date(t * 1000).toISOString().slice(0, 10);

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  const now = nowSeconds();
  const pro = await isAnalyticsPro(env, auth.userId, now);
  const maxDays = pro ? PRO_DAYS : FREE_DAYS;
  const asked = Number(new URL(request.url).searchParams.get('days'));
  const days = Number.isInteger(asked) && asked >= 7 ? Math.min(asked, maxDays) : Math.min(30, maxDays);
  const since = now - days * 86400;
  try {
    const posts = await listPostResults(env, auth.userId, since, pro ? 500 : FREE_POSTS);
    const networks = await followerSummary(env, auth.userId, dayOf(since));
    const series = pro ? await followerSeries(env, auth.userId, dayOf(since)) : [];
    const totals = posts.reduce((t, p) => ({ posts: t.posts + 1, views: t.views + (p.views ?? 0), likes: t.likes + (p.likes ?? 0), replies: t.replies + (p.replies ?? 0), reposts: t.reposts + (p.reposts ?? 0) }), { posts: 0, views: 0, likes: 0, replies: 0, reposts: 0 });
    return json({ ok: true, pro, days, maxDays, freePosts: FREE_POSTS, totals, networks, series, posts });
  } catch {
    return json({ ok: true, pro, days, maxDays, freePosts: FREE_POSTS, totals: { posts: 0, views: 0, likes: 0, replies: 0, reposts: 0 }, networks: [], series: [], posts: [] });
  }
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET');
