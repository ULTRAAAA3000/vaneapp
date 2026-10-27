import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { requireUser } from '../lib/auth';
import { isAnalyticsPro, PRO_DAYS } from '../lib/analyticsdata';
import { listChannels, pickChannels, queryBestTimes, queryCompare, type Filter } from '../lib/analyticsquery';
import { failCode, json, methodNotAllowed } from '../lib/http';
import { nowSeconds } from '../lib/usage';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  const now = nowSeconds();
  if (!(await isAnalyticsPro(env, auth.userId, now))) return failCode(402, 'pro_required', 'Compare networks and Best times are part of Analytics Pro.');
  const url = new URL(request.url);
  const asked = Number(url.searchParams.get('days'));
  const days = Number.isInteger(asked) && asked >= 7 ? Math.min(asked, PRO_DAYS) : 90;
  const since = now - days * 86400;
  try {
    const channels = await listChannels(env, auth.userId, '0000');
    const selected = pickChannels(url.searchParams.get('channels'), channels);
    const f: Filter = { userId: auth.userId, since, channels: selected, q: '' };
    const tz = (await env.DB.prepare('SELECT timezone FROM users WHERE id = ?1').bind(auth.userId).first<{ timezone: string }>())?.timezone ?? 'UTC';
    const [compare, best] = await Promise.all([queryCompare(env, { ...f, channels: pickChannels('all', channels) }), queryBestTimes(env, f, tz)]);
    return json({ ok: true, days, selected, compare, best, timeZone: tz });
  } catch {
    return json({ ok: true, days, selected: [], compare: [], best: { grid: [], top: [] }, timeZone: 'UTC' });
  }
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET');
