/**
 * GET /api/admin/extra-usage?month=YYYY-MM   (default: this month, UTC)
 *   → { ok, month, rows: [{ userId, email, posts, postsUsd, aiUses, aiUsd, totalUsd }], totalUsd, studio: [{ email, period, uses, usd }] }
 *
 * The list to invoice from: what each account used beyond its quota and what that comes to at the prices that applied. Extra use is
 * counted and priced when it happens but nothing charges it automatically; see lib/extrausage.ts. Vane Studio's extra AI
 * generations follow the video plan's own period, so they are listed on their own, newest first.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { requireAdmin } from '../lib/admin';
import { combineExtraUsage, type AiRow, type CounterRow } from '../lib/extrausage';
import { fail, json, methodNotAllowed } from '../lib/http';
import { nowSeconds, periodRange } from '../lib/usage';

const USD = 1_000_000;

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;
  const now = nowSeconds();
  const asked = new URL(request.url).searchParams.get('month');
  const month = asked ?? new Date(now * 1000).toISOString().slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return fail(400, 'month must look like 2026-10.');
  const { from, to } = periodRange(month, now);

  try {
    const [counters, ai, studio] = await Promise.all([
      env.DB
        .prepare(`SELECT c.user_id, u.email, c.overage_posts, c.overage_micro_usd FROM usage_counters c JOIN users u ON u.id = c.user_id WHERE c.period = ?1 AND (c.overage_posts > 0 OR c.overage_micro_usd > 0)`)
        .bind(month).all<CounterRow>(),
      env.DB
        .prepare(`SELECT l.user_id, u.email, COUNT(*) AS n, COALESCE(SUM(l.cost_micro_usd), 0) AS micro FROM usage_logs l JOIN users u ON u.id = l.user_id WHERE l.kind = 'ai_post' AND l.overage = 1 AND l.created_at >= ?1 AND l.created_at < ?2 GROUP BY l.user_id`)
        .bind(from, to).all<AiRow>(),
      env.DB
        .prepare(`SELECT u.email, v.period, v.uses, v.micro_usd FROM video_ai_overage v JOIN users u ON u.id = v.user_id WHERE v.micro_usd > 0 ORDER BY v.micro_usd DESC LIMIT 100`)
        .all<{ email: string; period: string; uses: number; micro_usd: number }>().catch(() => ({ results: [] as { email: string; period: string; uses: number; micro_usd: number }[] })),
    ]);
    const { rows, totalMicro } = combineExtraUsage(counters.results, ai.results);
    return json({
      ok: true,
      month,
      rows: rows.map((r) => ({ userId: r.userId, email: r.email, posts: r.posts, postsUsd: r.postsMicro / USD, aiUses: r.aiUses, aiUsd: r.aiMicro / USD, totalUsd: r.totalMicro / USD })),
      totalUsd: totalMicro / USD,
      studio: studio.results.map((s) => ({ email: s.email, period: s.period, uses: s.uses, usd: s.micro_usd / USD })),
    });
  } catch (err) {
    console.error('extra usage report failed', err instanceof Error ? err.message : 'unknown');
    return fail(500, 'Could not read the usage tables. Has schema.sql been applied?');
  }
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET');
