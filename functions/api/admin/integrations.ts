/**
 * /admin → Integrations: how Vane is connected to Claude, ChatGPT, Make, Zapier, WordPress and plain API users,
 * what state each one is in, whether it is switched on, and how much it is used (which tells where to build next).
 *
 * GET /api/admin/integrations            → the catalog + the admin's settings + 30 days of usage, per integration
 * PUT /api/admin/integrations?id=make    → { enabled?, listing?, note? }  (any subset)
 *       enabled: false  refuses every request from that integration (403 integration_disabled) until it is switched back on
 *       listing         where the store / marketplace review stands (see LISTING_STATES)
 *       note            the admin's own words (max 500 characters)
 *
 * The catalog (names, setup steps, URLs) is code: functions/api/lib/integrations.ts. The database only holds the admin's
 * switches and notes (integration_settings) and the counters (api_usage_daily). Needs `npm run db:remote` once.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { audit, requireAdmin } from '../lib/admin';
import { fail, isRecord, json, methodNotAllowed, readJson } from '../lib/http';
import {
  catalog, dayOf, forgetIntegrationSwitches, isIntegrationId, isMissingSchema, LISTING_LABELS, LISTING_STATES, type IntegrationId, type ListingState,
} from '../lib/integrations';

const NEEDS_DB = 'The database does not have the integrations tables yet. Run npm run db:remote once, then reload this page.';
const WINDOW_DAYS = 30;
const MAX_NOTE = 500;

interface SettingRow { id: string; enabled: number; listing: string; note: string; updated_at: number }

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;

  const now = Math.floor(Date.now() / 1000);
  // 30 UTC days, oldest first. The last entry is today.
  const days = Array.from({ length: WINDOW_DAYS }, (_, i) => dayOf(now - (WINDOW_DAYS - 1 - i) * 86400));
  const origin = new URL(request.url).origin;
  const defs = catalog(origin);

  const empty = (needsDb: boolean) => json({
    ok: true, needsDb, days, generatedAt: now,
    listingOptions: LISTING_STATES.map((v) => ({ value: v, label: LISTING_LABELS[v] })),
    totals: { today: 0, d7: 0, d30: 0, prev7: 0, keys7: 0, users30: 0, directShare: 0 },
    integrations: defs.map((d) => ({
      ...d, enabled: true, listing: '', listingLabel: LISTING_LABELS[''], note: '', updatedAt: null,
      state: d.build, activity: 'none',
      usage: { today: 0, d7: 0, d30: 0, prev7: 0, keys7: 0, keys30: 0, users30: 0, labelledKeys: 0, lastAt: null, series: days.map(() => 0), topOps: [] },
    })),
  });

  try {
    const since = days[0];
    const [perDay, keyCounts, userCounts, lasts, ops, settings] = await Promise.all([
      env.DB.prepare('SELECT integration, day, SUM(requests) AS r FROM api_usage_daily WHERE day >= ?1 GROUP BY integration, day').bind(since).all<{ integration: string; day: string; r: number }>(),
      env.DB.prepare(
        `SELECT integration, COUNT(DISTINCT CASE WHEN day >= ?2 THEN key_id END) AS k7, COUNT(DISTINCT key_id) AS k30
           FROM api_usage_daily WHERE day >= ?1 GROUP BY integration`,
      ).bind(since, days[WINDOW_DAYS - 7]).all<{ integration: string; k7: number; k30: number }>(),
      env.DB.prepare(
        `SELECT d.integration AS integration, COUNT(DISTINCT k.user_id) AS u
           FROM api_usage_daily d JOIN api_keys k ON k.id = d.key_id WHERE d.day >= ?1 GROUP BY d.integration`,
      ).bind(since).all<{ integration: string; u: number }>(),
      env.DB.prepare('SELECT integration, MAX(last_at) AS t FROM api_usage_daily GROUP BY integration').all<{ integration: string; t: number }>(),
      env.DB.prepare('SELECT integration, op, SUM(requests) AS r FROM api_usage_daily WHERE day >= ?1 GROUP BY integration, op ORDER BY r DESC LIMIT 300').bind(since).all<{ integration: string; op: string; r: number }>(),
      env.DB.prepare('SELECT id, enabled, listing, note, updated_at FROM integration_settings').all<SettingRow>(),
    ]);

    // How many live keys each integration has been told about (needs the api_keys.integration column; fine without it).
    const labelled = new Map<string, number>();
    try {
      const { results } = await env.DB.prepare('SELECT integration, COUNT(*) AS n FROM api_keys WHERE revoked_at IS NULL AND integration IS NOT NULL GROUP BY integration').all<{ integration: string; n: number }>();
      for (const r of results) labelled.set(r.integration, r.n);
    } catch (err) { if (!isMissingSchema(err)) throw err; }

    const series = new Map<string, number[]>();
    for (const r of perDay.results) {
      const i = days.indexOf(r.day);
      if (i < 0) continue;
      if (!series.has(r.integration)) series.set(r.integration, days.map(() => 0));
      series.get(r.integration)![i] += r.r;
    }
    const keys = new Map(keyCounts.results.map((r) => [r.integration, r]));
    const users = new Map(userCounts.results.map((r) => [r.integration, r.u]));
    const last = new Map(lasts.results.map((r) => [r.integration, r.t]));
    const sets = new Map(settings.results.map((r) => [r.id, r]));
    const topOps = new Map<string, { op: string; requests: number }[]>();
    for (const r of ops.results) {
      const list = topOps.get(r.integration) ?? [];
      if (list.length < 5) list.push({ op: r.op, requests: r.r });
      topOps.set(r.integration, list);
    }

    const integrations = defs.map((d) => {
      const s = sets.get(d.id);
      const enabled = s ? s.enabled === 1 : true;
      const ser = series.get(d.id) ?? days.map(() => 0);
      const d7 = sum(ser.slice(-7)), prev7 = sum(ser.slice(-14, -7)), d30 = sum(ser);
      const listing = (LISTING_STATES as readonly string[]).includes(s?.listing ?? '') ? ((s?.listing ?? '') as ListingState) : '';
      return {
        ...d,
        enabled, listing, listingLabel: LISTING_LABELS[listing], note: s?.note ?? '', updatedAt: s?.updated_at ?? null,
        // paused beats everything: a switched-off integration is paused whatever its build state
        state: enabled ? d.build : 'paused',
        activity: d7 > 0 ? 'active' : d30 > 0 ? 'idle' : 'none',
        usage: {
          today: ser[WINDOW_DAYS - 1], d7, d30, prev7,
          keys7: keys.get(d.id)?.k7 ?? 0, keys30: keys.get(d.id)?.k30 ?? 0, users30: users.get(d.id) ?? 0,
          labelledKeys: labelled.get(d.id) ?? 0, lastAt: last.get(d.id) ?? null, series: ser, topOps: topOps.get(d.id) ?? [],
        },
      };
    });

    const total = (pick: (u: (typeof integrations)[number]['usage']) => number) => integrations.reduce((a, i) => a + pick(i.usage), 0);
    const d30all = total((u) => u.d30);
    const direct = integrations.find((i) => i.id === 'api')?.usage.d30 ?? 0;
    return json({
      ok: true, needsDb: false, days, generatedAt: now,
      listingOptions: LISTING_STATES.map((v) => ({ value: v, label: LISTING_LABELS[v] })),
      totals: {
        today: total((u) => u.today), d7: total((u) => u.d7), d30: d30all, prev7: total((u) => u.prev7),
        keys7: total((u) => u.keys7),
        // a person with keys on two integrations counts twice here: fine for a feel of demand, see usage.users30 per integration
        users30: total((u) => u.users30),
        directShare: d30all ? direct / d30all : 0,
      },
      integrations,
    });
  } catch (err) {
    if (isMissingSchema(err)) return empty(true);
    console.error('admin integrations failed', err instanceof Error ? err.message : 'unknown');
    return fail(500, 'Could not load the integrations.');
  }
};

export const onRequestPut: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;

  const id = new URL(request.url).searchParams.get('id');
  if (!isIntegrationId(id)) return fail(404, 'No such integration');

  const parsed = await readJson(request, 4096);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  if (!isRecord(body)) return fail(400, 'Body must be a JSON object');

  const changes: { enabled?: boolean; listing?: ListingState; note?: string } = {};
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') return fail(400, 'enabled must be true or false');
    changes.enabled = body.enabled;
  }
  if (body.listing !== undefined) {
    if (typeof body.listing !== 'string' || !(LISTING_STATES as readonly string[]).includes(body.listing)) return fail(400, 'listing is not one of the allowed states');
    changes.listing = body.listing as ListingState;
  }
  if (body.note !== undefined) {
    if (typeof body.note !== 'string') return fail(400, 'note must be text');
    const note = body.note.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
    if (note.length > MAX_NOTE) return fail(400, `note is too long (max ${MAX_NOTE} characters)`);
    changes.note = note;
  }
  if (!Object.keys(changes).length) return fail(400, 'Nothing to change: send enabled, listing and/or note');

  try {
    const cur = await env.DB.prepare('SELECT id, enabled, listing, note, updated_at FROM integration_settings WHERE id = ?1').bind(id).first<SettingRow>();
    const next = {
      enabled: changes.enabled ?? (cur ? cur.enabled === 1 : true),
      listing: changes.listing ?? cur?.listing ?? '',
      note: changes.note ?? cur?.note ?? '',
    };
    const now = Math.floor(Date.now() / 1000);
    await env.DB
      .prepare(
        `INSERT INTO integration_settings (id, enabled, listing, note, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, listing = excluded.listing, note = excluded.note, updated_at = excluded.updated_at`,
      )
      .bind(id, next.enabled ? 1 : 0, next.listing, next.note, now)
      .run();
    forgetIntegrationSwitches();   // a switch takes effect at once on this server (within 10 s on the others)
    await audit(env, request, 'integration.update', id, changes);
    return json({ ok: true, integration: { id: id as IntegrationId, ...next, updatedAt: now } });
  } catch (err) {
    if (isMissingSchema(err)) return fail(503, NEEDS_DB);
    console.error('admin integration update failed', err instanceof Error ? err.message : 'unknown');
    return fail(500, 'Could not save the change.');
  }
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET, PUT');
