/** GET /api/admin/overview?days=30 → headline numbers, conversion funnel, sources, revenue, security snapshot */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { requireAdmin } from '../lib/admin';
import { json, methodNotAllowed } from '../lib/http';
import { dayLabels, daysParam, fillSeries } from '../lib/range';
import { listPlans } from '../lib/catalog';

type Row = Record<string, number | string | null>;

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;

  const days = daysParam(new URL(request.url));
  const now = Math.floor(Date.now() / 1000);
  const since = now - days * 86400;
  const q = (sql: string, ...binds: unknown[]) => env.DB.prepare(sql).bind(...binds);

  const r = await env.DB.batch([
    /* 0 */ q(`SELECT COUNT(*) total, COALESCE(SUM(created_at >= ?1),0) d1, COALESCE(SUM(created_at >= ?2),0) d7, COALESCE(SUM(created_at >= ?3),0) inrange FROM users`, now - 86400, now - 7 * 86400, since),
    /* 1 */ q(`SELECT date(created_at,'unixepoch') d, COUNT(*) n FROM users WHERE created_at >= ?1 GROUP BY d`, since),
    /* 2 */ q(`SELECT date(started_at,'unixepoch') d, COUNT(DISTINCT visitor_id) v, COUNT(*) views FROM web_views WHERE started_at >= ?1 GROUP BY d`, since),
    /* 3 */ q(`SELECT COUNT(DISTINCT visitor_id) visitors, COUNT(*) views, COUNT(DISTINCT sid) sessions FROM web_views WHERE started_at >= ?1`, since),
    /* 4 */ q(`SELECT COUNT(DISTINCT sid) n FROM web_views WHERE last_at >= ?1`, now - 90),
    /* 5 */ q(`SELECT AVG(dur) avg_dur, AVG(pages) avg_pages, SUM(pages = 1 AND dur < 10) * 1.0 / COUNT(*) bounce
              FROM (SELECT MAX(last_at) - MIN(started_at) dur, COUNT(*) pages FROM web_views WHERE started_at >= ?1 GROUP BY sid)`, since),
    /* 6 */ q(`SELECT COUNT(DISTINCT visitor_id) n FROM web_views WHERE started_at >= ?1 AND path = '/login'`, since),
    /* 7 */ q(`SELECT COUNT(*) n FROM users u WHERE u.created_at >= ?1 AND EXISTS (SELECT 1 FROM channels c WHERE c.user_id = u.id)`, since),
    /* 8 */ q(`SELECT COUNT(*) n FROM users u WHERE u.created_at >= ?1 AND EXISTS (SELECT 1 FROM posts p WHERE p.user_id = u.id AND p.status <> 'draft')`, since),
    /* 9 */ q(`SELECT COUNT(*) n FROM users u WHERE u.created_at >= ?1 AND EXISTS (SELECT 1 FROM subscriptions s WHERE s.user_id = u.id AND s.provider <> 'manual' AND s.plan <> 'free' AND s.status = 'active')`, since),
    /*10 */ q(`SELECT COALESCE(ref_host,'(direct)') src, COUNT(DISTINCT visitor_id) visitors FROM web_views WHERE started_at >= ?1 GROUP BY src ORDER BY visitors DESC LIMIT 8`, since),
    /*11 */ q(`SELECT COALESCE(ref_host,'(direct)') src, COUNT(*) n FROM user_attribution WHERE created_at >= ?1 GROUP BY src`, since),
    /*12 */ q(`SELECT plan, api_addon, COUNT(*) n FROM subscriptions WHERE status = 'active' AND provider <> 'manual' AND plan <> 'free' AND (current_period_end IS NULL OR current_period_end > ?1) GROUP BY plan, api_addon`, now),
    /*13 */ q(`SELECT COUNT(*) n FROM subscriptions WHERE status = 'active' AND provider = 'manual' AND plan <> 'free' AND (current_period_end IS NULL OR current_period_end > ?1)`, now),
    /*14 */ q(`SELECT (SELECT COUNT(*) FROM channels) channels, (SELECT COUNT(*) FROM waitlist) waitlist`),
    /*15 */ q(`SELECT status, COUNT(*) n FROM posts GROUP BY status`),
    /*16 */ q(`SELECT kind, ok, COUNT(*) n FROM auth_attempts WHERE ts >= ?1 GROUP BY kind, ok`, now - 86400),
    /*17 */ q(`SELECT COUNT(*) n FROM ip_blocks WHERE source <> 'preset' AND (expires_at IS NULL OR expires_at > ?1)`, now),
  ]);
  const rows = (i: number): Row[] => (r[i].results ?? []) as Row[];
  const one = (i: number): Row => rows(i)[0] ?? {};
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

  const labels = dayLabels(days);
  const users = one(0);
  const traffic = one(3);
  const sess = one(5);

  const signupsBySource = new Map(rows(11).map((x) => [String(x.src), num(x.n)]));
  const sources = rows(10).map((x) => ({ source: String(x.src), visitors: num(x.visitors), signups: signupsBySource.get(String(x.src)) ?? 0 }));

  // MRR: what the paying subscribers cost at today's catalog prices (monthly), plus the add-on where they have it.
  const catalog = new Map((await listPlans(env)).map((p) => [p.id, p.priceCents]));
  let paid = 0, mrr = 0;
  for (const row of rows(12)) {
    const n = num(row.n);
    paid += n;
    mrr += n * ((catalog.get(String(row.plan)) ?? 0) + (num(row.api_addon) ? (catalog.get('api-addon') ?? 0) : 0));
  }

  const att = (kind: string, ok: number) => rows(16).filter((x) => x.kind === kind && x.ok === ok).reduce((a, x) => a + num(x.n), 0);

  return json({
    ok: true,
    days,
    users: { total: num(users.total), last24h: num(users.d1), last7d: num(users.d7), inRange: num(users.inrange) },
    traffic: {
      visitors: num(traffic.visitors), views: num(traffic.views), sessions: num(traffic.sessions),
      activeNow: num(one(4).n), avgSessionSeconds: Math.round(num(sess.avg_dur)), avgPagesPerSession: Math.round(num(sess.avg_pages) * 10) / 10,
      bounceRate: Math.round(num(sess.bounce) * 1000) / 10,
    },
    series: {
      labels,
      signups: fillSeries(labels, rows(1) as { d: string; n: number }[], (x) => num(x.n)),
      visitors: fillSeries(labels, rows(2) as { d: string; v: number }[], (x) => num(x.v)),
      views: fillSeries(labels, rows(2) as { d: string; views: number }[], (x) => num(x.views)),
    },
    funnel: [
      { key: 'visitors', label: 'Visitors', count: num(traffic.visitors) },
      { key: 'login', label: 'Opened sign-in', count: num(one(6).n) },
      { key: 'registered', label: 'Signed up', count: num(users.inrange) },
      { key: 'channel', label: 'Connected a channel', count: num(one(7).n) },
      { key: 'posted', label: 'Scheduled a post', count: num(one(8).n) },
      { key: 'paid', label: 'Paid', count: num(one(9).n) },
    ],
    sources,
    revenue: { paidSubscribers: paid, mrrCents: mrr, activeGrants: num(one(13).n) },
    content: {
      channels: num(one(14).channels), waitlist: num(one(14).waitlist),
      posts: Object.fromEntries(rows(15).map((x) => [String(x.status), num(x.n)])),
    },
    security: {
      last24h: { loginOk: att('login', 1), loginFail: att('login', 0), registerOk: att('register', 1), registerFail: att('register', 0), adminFail: att('admin_login', 0) },
      activeBlocks: num(one(17).n),
    },
  });
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET');
