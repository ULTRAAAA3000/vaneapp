/** GET /api/admin/traffic?days=30 → time on site, pages, entry pages, geography, devices, referrers, live visitors */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { requireAdmin } from '../lib/admin';
import { json, methodNotAllowed } from '../lib/http';
import { dayLabels, daysParam, fillSeries } from '../lib/range';

type Row = Record<string, number | string | null>;

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;

  const days = daysParam(new URL(request.url));
  const now = Math.floor(Date.now() / 1000);
  const since = now - days * 86400;
  const q = (sql: string, ...binds: unknown[]) => env.DB.prepare(sql).bind(...binds);
  const SESS = `(SELECT sid, MIN(started_at) t0, MAX(last_at) - MIN(started_at) dur, COUNT(*) pages FROM web_views WHERE started_at >= ?1 GROUP BY sid)`;

  const r = await env.DB.batch([
    /* 0 */ q(`SELECT path, COUNT(*) views, COUNT(DISTINCT visitor_id) visitors, ROUND(AVG(last_at - started_at)) avg_time FROM web_views WHERE started_at >= ?1 GROUP BY path ORDER BY views DESC LIMIT 20`, since),
    /* 1 */ q(`SELECT v.path, COUNT(*) n FROM web_views v WHERE v.started_at >= ?1 AND v.started_at = (SELECT MIN(w.started_at) FROM web_views w WHERE w.sid = v.sid) GROUP BY v.path ORDER BY n DESC LIMIT 10`, since),
    /* 2 */ q(`SELECT COALESCE(country,'??') country, COUNT(DISTINCT visitor_id) visitors, COUNT(*) views FROM web_views WHERE started_at >= ?1 GROUP BY country ORDER BY visitors DESC LIMIT 15`, since),
    /* 3 */ q(`SELECT COALESCE(device,'?') device, COUNT(DISTINCT visitor_id) visitors FROM web_views WHERE started_at >= ?1 GROUP BY device ORDER BY visitors DESC`, since),
    /* 4 */ q(`SELECT COALESCE(ref_host,'(direct)') source, COUNT(DISTINCT visitor_id) visitors, COUNT(DISTINCT sid) sessions FROM web_views WHERE started_at >= ?1 GROUP BY source ORDER BY visitors DESC LIMIT 12`, since),
    /* 5 */ q(`SELECT CAST(strftime('%H', started_at, 'unixepoch') AS INTEGER) h, COUNT(*) n FROM web_views WHERE started_at >= ?1 GROUP BY h`, since),
    /* 6 */ q(`SELECT path, country, city, device, started_at, last_at FROM web_views WHERE last_at >= ?1 ORDER BY last_at DESC LIMIT 25`, now - 120),
    /* 7 */ q(`SELECT date(t0,'unixepoch') d, ROUND(AVG(dur)) avg_dur, COUNT(*) sessions FROM ${SESS} GROUP BY d`, since),
    /* 8 */ q(`SELECT CASE WHEN dur < 10 THEN '0-10s' WHEN dur < 30 THEN '10-30s' WHEN dur < 60 THEN '30-60s' WHEN dur < 180 THEN '1-3 min'
                          WHEN dur < 600 THEN '3-10 min' ELSE '10+ min' END bucket, COUNT(*) n FROM ${SESS} GROUP BY bucket`, since),
    /* 9 */ q(`SELECT ROUND(AVG(dur)) avg_dur, ROUND(AVG(pages),1) avg_pages, COUNT(*) sessions FROM ${SESS}`, since),
    /*10 */ q(`SELECT COALESCE(utm_source,'') utm, COUNT(DISTINCT visitor_id) visitors FROM web_views WHERE started_at >= ?1 AND utm_source IS NOT NULL GROUP BY utm ORDER BY visitors DESC LIMIT 10`, since),
  ]);
  const rows = (i: number): Row[] => (r[i].results ?? []) as Row[];
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
  const labels = dayLabels(days);
  const BUCKETS = ['0-10s', '10-30s', '30-60s', '1-3 min', '3-10 min', '10+ min'];
  const byBucket = new Map(rows(8).map((x) => [String(x.bucket), num(x.n)]));
  const hours = new Map(rows(5).map((x) => [num(x.h), num(x.n)]));

  return json({
    ok: true,
    days,
    summary: { avgSessionSeconds: num(rows(9)[0]?.avg_dur), avgPagesPerSession: num(rows(9)[0]?.avg_pages), sessions: num(rows(9)[0]?.sessions) },
    pages: rows(0), entryPages: rows(1), countries: rows(2), devices: rows(3), sources: rows(4), utm: rows(10),
    live: rows(6).map((x) => ({ path: x.path, country: x.country, city: x.city, device: x.device, seconds: num(x.last_at) - num(x.started_at) })),
    byHour: Array.from({ length: 24 }, (_, h) => hours.get(h) ?? 0),
    series: { labels, avgSessionSeconds: fillSeries(labels, rows(7) as { d: string; avg_dur: number }[], (x) => num(x.avg_dur)), sessions: fillSeries(labels, rows(7) as { d: string; sessions: number }[], (x) => num(x.sessions)) },
    durationBuckets: BUCKETS.map((b) => ({ bucket: b, sessions: byBucket.get(b) ?? 0 })),
  });
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET');
