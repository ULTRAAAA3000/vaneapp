import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { requireUser } from '../lib/auth';
import { activityByChannel, activityDaily, activityFailures, activityHabits, activityPunctuality, activityTotals, activityUpcoming, pickActivityChannels, streaks, type ActivityFilter } from '../lib/analyticsactivity';
import { FREE_DAYS, isAnalyticsPro, PRO_DAYS } from '../lib/analyticsdata';
import { listChannels } from '../lib/analyticsquery';
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
  const until = now + 1;
  const since = now - days * 86400;
  const base = { pro, days, maxDays };
  try {
    const channels = await listChannels(env, auth.userId, dayOf(since));
    const selected = pickActivityChannels(url.searchParams.get('channels'), channels);
    const f: ActivityFilter = { userId: auth.userId, since, until, channels: selected };
    const [totals, prev, upcoming, daily, byChannel] = await Promise.all([
      activityTotals(env, f),
      activityTotals(env, { ...f, since: since - days * 86400, until: since }),
      activityUpcoming(env, auth.userId, selected),
      activityDaily(env, f),
      activityByChannel(env, f),
    ]);
    const body: Record<string, unknown> = { ok: true, ...base, channels, selected, totals, prev: { sent: prev.sent, failed: prev.failed }, upcoming, daily, streak: streaks(daily, now) };
    // Free keeps the per-network counts; the rest of the picture is Pro.
    const byNetwork = new Map<string, { type: string; sent: number; failed: number }>();
    for (const c of byChannel) { const n = byNetwork.get(c.type) ?? { type: c.type, sent: 0, failed: 0 }; n.sent += c.sent; n.failed += c.failed; byNetwork.set(c.type, n); }
    body.byNetwork = [...byNetwork.values()].sort((a, b) => b.sent - a.sent);
    if (pro) {
      const tz = (await env.DB.prepare('SELECT timezone FROM users WHERE id = ?1').bind(auth.userId).first<{ timezone: string }>())?.timezone ?? 'UTC';
      const [habits, failures, punctuality] = await Promise.all([activityHabits(env, f, tz), activityFailures(env, f), activityPunctuality(env, f)]);
      Object.assign(body, { byChannel, habits, failures, punctuality, timeZone: tz });
    }
    return json(body);
  } catch {
    return json({ ok: true, ...base, channels: [], selected: [], totals: { sent: 0, failed: 0, media: 0, avgLen: null }, prev: { sent: 0, failed: 0 }, upcoming: 0, daily: [], streak: { current: 0, longest: 0, activeDays: 0 }, byNetwork: [] });
  }
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET');
