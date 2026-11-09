import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { requireUser } from '../lib/auth';
import { activityRows, pickActivityChannels } from '../lib/analyticsactivity';
import { followerRows, isAnalyticsPro, PRO_DAYS } from '../lib/analyticsdata';
import { listChannels, pickChannels, queryPosts, type Filter } from '../lib/analyticsquery';
import { failCode, methodNotAllowed } from '../lib/http';
import { nowSeconds } from '../lib/usage';

const cell = (v: unknown): string => {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  const now = nowSeconds();
  if (!(await isAnalyticsPro(env, auth.userId, now))) return failCode(402, 'pro_required', 'Export is part of Analytics Pro.');
  const url = new URL(request.url);
  const asked = Number(url.searchParams.get('days'));
  const days = Number.isInteger(asked) && asked >= 7 ? Math.min(asked, PRO_DAYS) : 30;
  const channels = await listChannels(env, auth.userId, '0000');
  const since = now - days * 86400;
  const kind = url.searchParams.get('kind');
  let rows: unknown[][];
  let name = 'vane-analytics';
  if (kind === 'followers') {
    const picked = pickChannels(url.searchParams.get('channels'), channels);
    const list = await followerRows(env, auth.userId, new Date(since * 1000).toISOString().slice(0, 10), picked);
    rows = [['day', 'network', 'channel', 'followers'], ...list.map((r) => [r.day, r.type, r.name, r.followers])];
    name = 'vane-followers';
  } else if (kind === 'activity') {
    const list = await activityRows(env, { userId: auth.userId, since, until: now + 1, channels: pickActivityChannels(url.searchParams.get('channels'), channels) });
    rows = [['day', 'network', 'channel', 'sent', 'failed'], ...list.map((r) => [r.day, r.type, r.name, r.sent, r.failed])];
    name = 'vane-activity';
  } else {
    const f: Filter = { userId: auth.userId, since, channels: pickChannels(url.searchParams.get('channels'), channels), q: (url.searchParams.get('q') ?? '').trim().slice(0, 80) };
    const { items } = await queryPosts(env, f, 'new', 5000, 0);
    rows = [['date', 'network', 'channel', 'text', 'views', 'likes', 'replies', 'reposts'], ...items.map((p) => [new Date(p.sent_at * 1000).toISOString(), p.type, p.channel, p.content, p.views, p.likes, p.replies, p.reposts])];
  }
  return new Response(rows.map((r) => r.map(cell).join(',')).join('\r\n'), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}.csv"`, 'cache-control': 'no-store' } });
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET');
