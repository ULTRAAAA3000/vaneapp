/**
 * POST /api/usage/overage  { enabled: boolean }  → { ok, ai, overage }
 *
 * The "when the credits or the quota run out" switch of the dashboard:
 *   enabled = false → requests over the limit are refused (nothing is ever charged)
 *   enabled = true  → they go through and are billed at the plan's / AI Pass's per-use price
 * It only exists for accounts that have a price to bill: a plan with overage rates, or an AI Pass.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { requireUser } from '../lib/auth';
import { aiExtraRate } from '../lib/usage';
import { failCode, fail, isRecord, json, methodNotAllowed, readJson } from '../lib/http';
import { loadAiPass } from '../lib/aipass';
import { specOf } from '../lib/plans';
import { loadSubscription, nowSeconds, usageSummary } from '../lib/usage';

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  const parsed = await readJson(request, 1024);
  if (!parsed.ok) return parsed.response;
  if (!isRecord(parsed.data) || typeof parsed.data.enabled !== 'boolean') return fail(400, 'enabled must be true or false.');
  const enabled = parsed.data.enabled;

  const now = nowSeconds();
  const sub = await loadSubscription(env, auth.userId, now);
  if (enabled) {
    const spec = specOf(sub.plan);
    const pass = await loadAiPass(env, auth.userId, now);
    if (!spec.overage && aiExtraRate(spec, pass.active) === null) {
      return failCode(400, 'overage_not_available', 'Your plan has nothing to bill for extra use. Get the AI Pass or a plan with extras first.');
    }
  }
  await env.DB
    .prepare(
      `INSERT INTO subscriptions (user_id, plan, status, overage_enabled, provider, created_at, updated_at) VALUES (?1, 'free', 'active', ?2, 'manual', ?3, ?3)
       ON CONFLICT(user_id) DO UPDATE SET overage_enabled = ?2, updated_at = ?3`,
    )
    .bind(auth.userId, enabled ? 1 : 0, now)
    .run();
  const usage = await usageSummary(env, auth.userId, await loadSubscription(env, auth.userId, now), now);
  return json({ ok: true, ai: usage.ai, overage: usage.overage });
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('POST');
