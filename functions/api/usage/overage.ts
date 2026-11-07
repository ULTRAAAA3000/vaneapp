/**
 * POST /api/usage/overage  { enabled?: boolean, capUsd?: number }  → { ok, ai, overage }
 *
 * The "when the credits or the quota run out" switch of the dashboard:
 *   enabled = false → requests over the limit are refused (nothing is ever charged)
 *   enabled = true  → they go through and are billed at the plan's / AI Pass's per-use price
 * capUsd is the monthly ceiling for everything billed as extra ($1 to $1,000; $20 until the account sets its own): at the ceiling
 * further extra use is refused with 402 overage_cap_reached.
 * It only exists for accounts that have a price to bill: a plan with overage rates, or an AI Pass.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { requireUser } from '../lib/auth';
import { aiExtraRate } from '../lib/usage';
import { failCode, fail, isRecord, json, methodNotAllowed, readJson } from '../lib/http';
import { loadAiPass } from '../lib/aipass';
import { DEFAULT_OVERAGE_CAP_MICRO, specOf } from '../lib/plans';
import { loadSubscription, nowSeconds, usageSummary } from '../lib/usage';

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  const parsed = await readJson(request, 1024);
  if (!parsed.ok) return parsed.response;
  if (!isRecord(parsed.data)) return fail(400, 'Send enabled and/or capUsd.');
  const { enabled: rawEnabled, capUsd } = parsed.data;
  if (rawEnabled !== undefined && typeof rawEnabled !== 'boolean') return fail(400, 'enabled must be true or false.');
  if (capUsd !== undefined && (typeof capUsd !== 'number' || !Number.isFinite(capUsd) || capUsd < 1 || capUsd > 1000)) return fail(400, 'capUsd must be a number from 1 to 1000.');
  if (rawEnabled === undefined && capUsd === undefined) return fail(400, 'Send enabled and/or capUsd.');

  const now = nowSeconds();
  const sub = await loadSubscription(env, auth.userId, now);
  if (rawEnabled === true) {
    const spec = specOf(sub.plan);
    const pass = await loadAiPass(env, auth.userId, now);
    if (!spec.overage && aiExtraRate(spec, pass.active) === null) {
      return failCode(400, 'overage_not_available', 'Your plan has nothing to bill for extra use. Get the AI Pass or a plan with extras first.');
    }
  }
  await env.DB
    .prepare(
      `INSERT INTO subscriptions (user_id, plan, status, overage_enabled, overage_cap_micro_usd, provider, created_at, updated_at)
       VALUES (?1, 'free', 'active', COALESCE(?2, 0), COALESCE(?3, ?5), 'manual', ?4, ?4)
       ON CONFLICT(user_id) DO UPDATE SET overage_enabled = COALESCE(?2, overage_enabled), overage_cap_micro_usd = COALESCE(?3, overage_cap_micro_usd), updated_at = ?4`,
    )
    .bind(auth.userId, rawEnabled === undefined ? null : rawEnabled ? 1 : 0, capUsd === undefined ? null : Math.round(capUsd * 1_000_000), now, DEFAULT_OVERAGE_CAP_MICRO)
    .run();
  const usage = await usageSummary(env, auth.userId, await loadSubscription(env, auth.userId, now), now);
  return json({ ok: true, ai: usage.ai, overage: usage.overage });
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('POST');
