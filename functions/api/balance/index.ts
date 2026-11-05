/**
 * GET /api/balance   (signed in)
 *   → { ok, balanceUsd, min: 5, max: 500, presets: [5, 10, 25, 50, 100],
 *       extra: { enabled, available, postUsd, aiUsd },        // the "pay for extra use" switch and the prices it would apply
 *       limit: { reached, postsLeft, resetsAt, ... },         // see UsageSummary.limit
 *       ledger: [{ kind, usd, what, note, at }] }
 *
 * The prepaid balance page's data (public/topup.html). Money goes IN through the normal checkout (`/checkout?plan=balance&amount=25`,
 * from $5), and goes OUT only for extra use beyond the plan's quota (extra posts, extra AI credits, extra Studio AI), and only while
 * "pay for extra use" is switched on (POST /api/usage/overage). The balance never goes below zero and nothing is ever owed.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { requireUser } from '../lib/auth';
import { MAX_TOPUP_CENTS, MIN_TOPUP_CENTS, recentLedger } from '../lib/balance';
import { json, methodNotAllowed } from '../lib/http';
import { loadSubscription, nowSeconds, usageSummary } from '../lib/usage';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  const now = nowSeconds();
  const sub = await loadSubscription(env, auth.userId, now);
  const usage = await usageSummary(env, auth.userId, sub, now);
  return json(
    {
      ok: true,
      balanceUsd: usage.balanceUsd,
      min: MIN_TOPUP_CENTS / 100,
      max: MAX_TOPUP_CENTS / 100,
      presets: [5, 10, 25, 50, 100],
      extra: {
        enabled: usage.ai.extra.enabled,
        // is there anything on this plan (or the AI Pass) that has a price for extra use
        available: usage.limit.offersExtra || usage.ai.extra.rateUsd !== null,
        postUsd: usage.limit.extraPostUsd,
        aiUsd: usage.ai.extra.rateUsd,
      },
      plan: usage.plan.label,
      limit: usage.limit,
      ledger: await recentLedger(env, auth.userId, 20),
    },
    200,
    { 'Cache-Control': 'no-store' },
  );
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET');
