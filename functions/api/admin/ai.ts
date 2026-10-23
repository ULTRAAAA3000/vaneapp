/**
 * GET /api/admin/ai?days=30 → the AI token ledger: tokens, neurons, cost, by feature / model / user, the month against the budget,
 *     the month's projection and a `setup` check (is the AI binding there, is the model priced?)
 * GET /api/admin/ai?days=30&format=csv → the same period's calls, one row each, as a CSV download (logged in the audit trail)
 * PUT /api/admin/ai { model, inputUsdPerM, outputUsdPerM, inputNeuronsPerM, outputNeuronsPerM } → set what a model costs
 *
 * "List cost" is tokens × the model's price. Cloudflare also gives 10 000 neurons a day free and bills the rest at
 * $0.011 per 1000, so the report shows that too ("after the free allowance"): note the allowance is per Cloudflare account,
 * shared with anything else that uses Workers AI, which this ledger does not see.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { audit, requireAdmin } from '../lib/admin';
import { invalidateAiPrices } from '../lib/aimeter';
import { isPremiumTool, modelOf } from '../lib/ai';
import { fail, isRecord, json, methodNotAllowed, readJson } from '../lib/http';
import { dayLabels, daysParam, fillSeries } from '../lib/range';
import { getSettings } from '../lib/settings';

export const FREE_NEURONS_PER_DAY = 10_000;
export const USD_PER_1000_NEURONS = 0.011;

type Row = Record<string, number | string | null>;
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const days = daysParam(url, 30);
  const now = Math.floor(Date.now() / 1000);
  const since = now - days * 86400;

  if (url.searchParams.get('format') === 'csv') return exportCsv(env, request, days, since);
  const d = new Date();
  const monthStart = Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000);
  const q = (sql: string, ...b: unknown[]) => env.DB.prepare(sql).bind(...b);

  const r = await env.DB.batch([
    /* 0 */ q(`SELECT COUNT(*) calls, COALESCE(SUM(ok),0) ok, COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o, COALESCE(SUM(neurons),0) neurons,
                     COALESCE(SUM(cost_micro),0) cost, COALESCE(SUM(estimated),0) estimated, COUNT(DISTINCT user_id) users, ROUND(AVG(ms)) ms
                FROM ai_usage WHERE ts >= ?1`, since),
    /* 1 */ q(`SELECT date(ts,'unixepoch') d, COUNT(*) calls, SUM(input_tokens) i, SUM(output_tokens) o, SUM(neurons) neurons, SUM(cost_micro) cost
                FROM ai_usage WHERE ts >= ?1 GROUP BY d`, since),
    /* 2 */ q(`SELECT tool, COUNT(*) calls, SUM(ok) ok, SUM(input_tokens) i, SUM(output_tokens) o, SUM(neurons) neurons, SUM(cost_micro) cost, ROUND(AVG(ms)) ms
                FROM ai_usage WHERE ts >= ?1 GROUP BY tool ORDER BY cost DESC, (i + o) DESC`, since),
    /* 3 */ q(`SELECT u.model, COUNT(*) calls, SUM(u.input_tokens) i, SUM(u.output_tokens) o, SUM(u.cost_micro) cost, MAX(p.model) priced
                FROM ai_usage u LEFT JOIN ai_prices p ON p.model = u.model WHERE u.ts >= ?1 GROUP BY u.model ORDER BY cost DESC`, since),
    /* 4 */ q(`SELECT u.user_id, x.email, COUNT(*) calls, SUM(u.input_tokens + u.output_tokens) tokens, SUM(u.cost_micro) cost, MAX(u.ts) last_ts
                FROM ai_usage u LEFT JOIN users x ON x.id = u.user_id WHERE u.ts >= ?1 GROUP BY u.user_id ORDER BY tokens DESC LIMIT 15`, since),
    /* 5 */ q(`SELECT model, input_usd_per_m, output_usd_per_m, input_neurons_per_m, output_neurons_per_m, updated_at FROM ai_prices ORDER BY model`),
    /* 6 */ q(`SELECT COALESCE(SUM(cost_micro),0) cost, COALESCE(SUM(input_tokens + output_tokens),0) tokens FROM ai_usage WHERE ts >= ?1`, monthStart),
    /* 7 */ q(`SELECT u.ts, u.tool, u.model, u.input_tokens i, u.output_tokens o, u.estimated, u.ok, u.ms, x.email
                FROM ai_usage u LEFT JOIN users x ON x.id = u.user_id ORDER BY u.id DESC LIMIT 20`),
    /* 8 */ q(`SELECT COALESCE(SUM(neurons),0) neurons FROM ai_usage WHERE ts >= ?1`, Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000)),
  ]);
  const rows = (i: number) => (r[i].results ?? []) as Row[];
  const t = rows(0)[0] ?? {};
  const labels = dayLabels(days);
  const daily = rows(1) as unknown as { d: string; calls: number; i: number; o: number; neurons: number; cost: number }[];

  // what Cloudflare would really bill: each day's neurons beyond the free 10 000
  const afterFreeUsd = daily.reduce((a, x) => a + Math.max(0, num(x.neurons) - FREE_NEURONS_PER_DAY) * (USD_PER_1000_NEURONS / 1000), 0);
  const budget = (await getSettings(env)).ai_budget_usd;
  const monthUsd = num(rows(6)[0]?.cost) / 1e6;
  // where the month is heading at today's pace (needs a day of data, otherwise it would be noise)
  const daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  const elapsedDays = (now - monthStart) / 86400;
  const projectedUsd = monthUsd > 0 && elapsedDays >= 1 ? (monthUsd / elapsedDays) * daysInMonth : null;
  const model = modelOf(env);

  return json({
    ok: true,
    days,
    totals: {
      calls: num(t.calls), failed: num(t.calls) - num(t.ok), inputTokens: num(t.i), outputTokens: num(t.o), tokens: num(t.i) + num(t.o),
      neurons: Math.round(num(t.neurons)), costUsd: num(t.cost) / 1e6, afterFreeAllowanceUsd: afterFreeUsd, estimatedCalls: num(t.estimated),
      users: num(t.users), avgMs: num(t.ms),
    },
    today: { neurons: Math.round(num(rows(8)[0]?.neurons)), freeNeurons: FREE_NEURONS_PER_DAY },
    month: {
      costUsd: monthUsd, tokens: num(rows(6)[0]?.tokens), budgetUsd: budget, budgetUsedPct: budget > 0 ? Math.round((monthUsd / budget) * 1000) / 10 : null,
      projectedUsd, projectedPct: budget > 0 && projectedUsd !== null ? Math.round((projectedUsd / budget) * 1000) / 10 : null,
    },
    // why a panel might be empty: no AI binding on this server, or the model it runs on has no price yet
    setup: { aiBinding: Boolean(env.AI), model, modelPriced: rows(5).some((x) => x.model === model), budgetSet: budget > 0 },
    series: {
      labels,
      inputTokens: fillSeries(labels, daily, (x) => num(x.i)),
      outputTokens: fillSeries(labels, daily, (x) => num(x.o)),
      calls: fillSeries(labels, daily, (x) => num(x.calls)),
      costUsd: fillSeries(labels, daily, (x) => Math.round(num(x.cost)) / 1e6),
    },
    byTool: rows(2).map((x) => ({
      tool: x.tool, premium: isPremiumTool(String(x.tool)), calls: num(x.calls), failed: num(x.calls) - num(x.ok), inputTokens: num(x.i), outputTokens: num(x.o),
      neurons: Math.round(num(x.neurons)), costUsd: num(x.cost) / 1e6, avgMs: num(x.ms),
    })),
    byModel: rows(3).map((x) => ({ model: x.model, calls: num(x.calls), inputTokens: num(x.i), outputTokens: num(x.o), costUsd: num(x.cost) / 1e6, priced: x.priced !== null })),
    topUsers: rows(4).map((x) => ({ userId: x.user_id, email: x.email, calls: num(x.calls), tokens: num(x.tokens), costUsd: num(x.cost) / 1e6, lastAt: x.last_ts })),
    prices: rows(5).map((x) => ({ model: x.model, inputUsdPerM: x.input_usd_per_m, outputUsdPerM: x.output_usd_per_m, inputNeuronsPerM: x.input_neurons_per_m, outputNeuronsPerM: x.output_neurons_per_m, updatedAt: x.updated_at })),
    recent: rows(7).map((x) => ({ ts: x.ts, tool: x.tool, model: x.model, inputTokens: num(x.i), outputTokens: num(x.o), estimated: x.estimated === 1, ok: x.ok === 1, ms: x.ms, email: x.email })),
  });
};

const CSV_COLUMNS = ['time_utc', 'user', 'feature', 'model', 'input_tokens', 'output_tokens', 'tokens_estimated', 'neurons', 'cost_usd', 'ok', 'ms'];
const CSV_MAX_ROWS = 50_000;

/** One CSV cell. Quotes when needed, and defuses a spreadsheet formula ("=", "+", "-", "@" at the start) so an exported email or tool name can never run. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function exportCsv(env: Env, request: Request, days: number, since: number): Promise<Response> {
  const { results } = await env.DB
    .prepare(
      `SELECT u.ts, x.email, u.tool, u.model, u.input_tokens, u.output_tokens, u.estimated, u.neurons, u.cost_micro, u.ok, u.ms
         FROM ai_usage u LEFT JOIN users x ON x.id = u.user_id WHERE u.ts >= ?1 ORDER BY u.id DESC LIMIT ?2`,
    )
    .bind(since, CSV_MAX_ROWS)
    .all<{ ts: number; email: string | null; tool: string; model: string; input_tokens: number; output_tokens: number; estimated: number; neurons: number; cost_micro: number; ok: number; ms: number | null }>();
  const lines = [CSV_COLUMNS.join(',')];
  for (const r of results) {
    lines.push([
      new Date(r.ts * 1000).toISOString().replace('T', ' ').slice(0, 19), r.email ?? 'system', r.tool, r.model, r.input_tokens, r.output_tokens, r.estimated ? 'yes' : 'no',
      Math.round(r.neurons * 100) / 100, (r.cost_micro / 1e6).toFixed(6), r.ok ? 'yes' : 'no', r.ms,
    ].map(csvCell).join(','));
  }
  await audit(env, request, 'ai.export', `${days}d`, { rows: results.length });
  return new Response(lines.join('\r\n') + '\r\n', {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="vane-ai-usage-${days}d.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}

export const onRequestPut: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;
  const parsed = await readJson(request, 2048);
  if (!parsed.ok) return parsed.response;
  const b = parsed.data;
  if (!isRecord(b) || typeof b.model !== 'string' || !/^[@A-Za-z0-9._/:-]{3,80}$/.test(b.model)) return fail(400, 'model is required (its Workers AI id, e.g. @cf/meta/llama-3.1-8b-instruct).');
  const fields = ['inputUsdPerM', 'outputUsdPerM', 'inputNeuronsPerM', 'outputNeuronsPerM'] as const;
  const v: Record<string, number> = {};
  for (const f of fields) {
    const x = b[f];
    if (typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x > 1_000_000) return fail(400, `${f} must be a number between 0 and 1,000,000.`);
    v[f] = x;
  }
  await env.DB
    .prepare(
      `INSERT INTO ai_prices (model, input_usd_per_m, output_usd_per_m, input_neurons_per_m, output_neurons_per_m, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, unixepoch())
       ON CONFLICT(model) DO UPDATE SET input_usd_per_m = excluded.input_usd_per_m, output_usd_per_m = excluded.output_usd_per_m,
         input_neurons_per_m = excluded.input_neurons_per_m, output_neurons_per_m = excluded.output_neurons_per_m, updated_at = excluded.updated_at`,
    )
    .bind(b.model, v.inputUsdPerM, v.outputUsdPerM, v.inputNeuronsPerM, v.outputNeuronsPerM)
    .run();
  invalidateAiPrices();
  await audit(env, request, 'ai.price', b.model, v);
  return json({ ok: true });
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET, PUT');
