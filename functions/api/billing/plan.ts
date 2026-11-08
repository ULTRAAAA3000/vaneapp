/** GET /api/billing/plan?id=pro → the plan the checkout page is about to sell (also one that is not on the landing page, like the AI Pass). */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { fail, json, methodNotAllowed } from '../lib/http';
import { BALANCE_PLAN_ID, parseTopUpCents, topUpPlan } from '../lib/balance';
import { billingEnabled, getPlan, isBuyable, previewActive } from '../lib/billing';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const q = new URL(request.url).searchParams;
  const id = q.get('id') ?? '';
  // ?id=balance&amount=25 → a top-up of $25 (not a catalog plan: the amount is the buyer's, checked here and again at checkout)
  const cents = id === BALANCE_PLAN_ID ? parseTopUpCents(q.get('amount')) : null;
  if (id === BALANCE_PLAN_ID && cents === null) return fail(400, 'Choose an amount in whole dollars, from $5 to $500.');
  const p = cents !== null ? topUpPlan(cents) : /^[a-z0-9-]{1,40}$/.test(id) ? await getPlan(env, id) : null;
  const preview = !billingEnabled(env) && (await previewActive(env, request));
  if (!p || (!p.isActive && !preview)) return fail(404, 'This plan does not exist or is not on sale.');
  return json({
    ok: true,
    plan: {
      id: p.id, kind: p.kind, name: p.name, tagline: p.tagline, badge: p.badge, priceCents: p.priceCents, yearlyPriceCents: p.yearlyPriceCents,
      comparePriceCents: p.comparePriceCents, currency: p.currency, interval: p.interval, features: p.features, ctaLabel: p.ctaLabel, buyable: preview || (billingEnabled(env) && isBuyable(p)),
    },
  });
};
export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET');
