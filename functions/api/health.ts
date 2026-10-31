/**
 * GET /api/health  (public, no cookies, never cached)
 *   { ok, status: 'operational' | 'degraded' | 'down', checks: { database, publishing }, delaySeconds?, colo, checkedAt }
 *   200 when operational or degraded, 503 when the database does not answer. What the words mean: functions/api/lib/health.ts.
 * GET /api/health?ping=1
 *   { ok: true, colo }   answers at once without touching the database. The status badge times it to show the latency
 *   between the visitor and the Cloudflare edge that served them.
 *
 * `colo` is the Cloudflare data centre that answered (for example "FRA"); null outside Cloudflare (local dev).
 * The full check is remembered for 10 seconds per isolate, so a crowd of open dashboards costs the database almost nothing.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../types';
import { json, methodNotAllowed } from './lib/http';
import { evaluate, type Health } from './lib/health';

const NO_STORE = { 'Cache-Control': 'no-store' };
const MEMO_MS = 10_000;
let memo: { at: number; health: Health } | null = null;

const coloOf = (request: Request): string | null => {
  const c = (request as unknown as { cf?: { colo?: unknown } }).cf?.colo;
  return typeof c === 'string' && /^[A-Z]{3,4}$/.test(c) ? c : null;
};

async function check(env: Env, now: number): Promise<Health> {
  try {
    const ok = await env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>();
    if (!ok) return evaluate(false, null, null, now);
    // Both reads are single index lookups (idx_posts_due), cheap however many posts exist.
    const due = await env.DB.prepare(`SELECT MIN(scheduled_at) AS t FROM posts WHERE status = 'scheduled'`).first<{ t: number | null }>();
    const stuck = await env.DB.prepare(`SELECT MIN(updated_at) AS t FROM posts WHERE status = 'processing'`).first<{ t: number | null }>();
    return evaluate(true, due?.t ?? null, stuck?.t ?? null, now);
  } catch (e) {
    console.error('health: database check failed:', e instanceof Error ? e.message : e);
    return evaluate(false, null, null, now);
  }
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const colo = coloOf(request);
  if (new URL(request.url).searchParams.has('ping')) return json({ ok: true, colo }, 200, NO_STORE);

  const t = Date.now();
  if (!memo || t - memo.at > MEMO_MS) memo = { at: t, health: await check(env, Math.floor(t / 1000)) };
  const h = memo.health;
  return json({ ok: h.status !== 'down', ...h, colo, checkedAt: Math.floor(memo.at / 1000) }, h.status === 'down' ? 503 : 200, NO_STORE);
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET');
