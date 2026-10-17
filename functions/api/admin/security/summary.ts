/** GET /api/admin/security/summary?days=7 → attempts per day, noisiest addresses, countries, networks, reasons */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../../types';
import { requireAdmin } from '../../lib/admin';
import { json, methodNotAllowed } from '../../lib/http';
import { dayLabels, daysParam, fillSeries } from '../../lib/range';

type Row = Record<string, number | string | null>;

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;
  const days = daysParam(new URL(request.url), 7);
  const now = Math.floor(Date.now() / 1000);
  const since = now - days * 86400;
  const q = (sql: string, ...b: unknown[]) => env.DB.prepare(sql).bind(...b);

  const r = await env.DB.batch([
    /* 0 */ q(`SELECT date(ts,'unixepoch') d, kind, ok, COUNT(*) n FROM auth_attempts WHERE ts >= ?1 GROUP BY d, kind, ok`, since),
    /* 1 */ q(`SELECT ip, COUNT(*) total, SUM(ok = 0) fails, SUM(kind = 'register') registers, MAX(country) country, MAX(city) city, MAX(asn) asn, MAX(as_org) as_org, MAX(ts) last_ts
               FROM auth_attempts WHERE ts >= ?1 GROUP BY ip ORDER BY fails DESC, total DESC LIMIT 15`, since),
    /* 2 */ q(`SELECT COALESCE(country,'??') country, SUM(kind = 'login') logins, SUM(kind = 'register') registers, SUM(ok = 0) fails
               FROM auth_attempts WHERE ts >= ?1 AND kind IN ('login','register') GROUP BY country ORDER BY (logins + registers) DESC LIMIT 15`, since),
    /* 3 */ q(`SELECT asn, MAX(as_org) as_org, COUNT(*) total, SUM(ok = 0) fails FROM auth_attempts WHERE ts >= ?1 AND asn IS NOT NULL GROUP BY asn ORDER BY fails DESC, total DESC LIMIT 12`, since),
    /* 4 */ q(`SELECT COALESCE(reason,'ok') reason, kind, COUNT(*) n FROM auth_attempts WHERE ts >= ?1 GROUP BY reason, kind ORDER BY n DESC LIMIT 15`, since),
    /* 5 */ q(`SELECT value FROM ip_blocks WHERE kind = 'ip' AND (expires_at IS NULL OR expires_at > ?1)`, now),
    /* 6 */ q(`SELECT source, COUNT(*) n FROM ip_blocks WHERE expires_at IS NULL OR expires_at > ?1 GROUP BY source`, now),
  ]);
  const rows = (i: number) => (r[i].results ?? []) as Row[];
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
  const labels = dayLabels(days);
  const series = (kind: string, ok: number) => fillSeries(labels, rows(0).filter((x) => x.kind === kind && x.ok === ok) as unknown as { d: string; n: number }[], (x) => num(x.n));
  const banned = new Set(rows(5).map((x) => String(x.value)));

  return json({
    ok: true,
    days,
    series: { labels, loginOk: series('login', 1), loginFail: series('login', 0), registerOk: series('register', 1), registerFail: series('register', 0), adminFail: series('admin_login', 0) },
    topIps: rows(1).map((x) => ({ ...x, blocked: banned.has(String(x.ip)) })),
    countries: rows(2), networks: rows(3), reasons: rows(4),
    blocks: Object.fromEntries(rows(6).map((x) => [String(x.source), num(x.n)])),
  });
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET');
