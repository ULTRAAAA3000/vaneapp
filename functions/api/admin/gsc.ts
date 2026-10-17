/**
 * GET /api/admin/gsc?days=28 → Google Search Console: totals, daily series, top queries / pages / countries / devices
 * (see lib/google.ts for the 3-step setup). Cached for 10 minutes: the data only changes daily.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { requireAdmin } from '../lib/admin';
import { gscSite, readServiceAccount, searchAnalytics, type GscRow } from '../lib/google';
import { json, methodNotAllowed } from '../lib/http';

const cache = new Map<string, { at: number; body: unknown }>();
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;
  if (!readServiceAccount(env)) return json({ ok: true, configured: false });

  const n = Number(new URL(request.url).searchParams.get('days'));
  const days = [7, 28, 90, 180].includes(n) ? n : 28;
  const key = `${gscSite(env)}|${days}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 600_000) return json(hit.body);

  const end = Date.now();
  const range = { startDate: iso(end - days * 86400_000), endDate: iso(end) };
  try {
    const [byDate, queries, pages, countries, devices] = await Promise.all([
      searchAnalytics(env, { ...range, dimensions: ['date'], rowLimit: 500 }),
      searchAnalytics(env, { ...range, dimensions: ['query'], rowLimit: 25 }),
      searchAnalytics(env, { ...range, dimensions: ['page'], rowLimit: 25 }),
      searchAnalytics(env, { ...range, dimensions: ['country'], rowLimit: 15 }),
      searchAnalytics(env, { ...range, dimensions: ['device'], rowLimit: 5 }),
    ]);
    const clicks = byDate.reduce((a, r) => a + r.clicks, 0);
    const impressions = byDate.reduce((a, r) => a + r.impressions, 0);
    const position = impressions ? byDate.reduce((a, r) => a + r.position * r.impressions, 0) / impressions : 0;
    const shape = (rows: GscRow[]) => rows.map((r) => ({ key: r.keys[0], clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position }));
    const body = {
      ok: true, configured: true, site: gscSite(env), range, days,
      totals: { clicks, impressions, ctr: impressions ? clicks / impressions : 0, position },
      series: shape(byDate).sort((a, b) => String(a.key).localeCompare(String(b.key))),
      queries: shape(queries), pages: shape(pages), countries: shape(countries), devices: shape(devices),
    };
    cache.set(key, { at: Date.now(), body });
    return json(body);
  } catch (err) {
    return json({ ok: true, configured: true, site: gscSite(env), error: err instanceof Error ? err.message : 'Search Console request failed' });
  }
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET');
