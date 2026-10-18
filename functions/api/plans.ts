/** GET /api/plans → the public price list. The landing page renders its pricing section from this. */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../types';
import { json, methodNotAllowed } from './lib/http';
import { listPlans } from './lib/catalog';

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const plans = (await listPlans(env, { publicOnly: true })).map((p) => ({
    id: p.id,
    kind: p.kind,
    name: p.name,
    tagline: p.tagline,
    badge: p.badge,
    priceCents: p.priceCents,
    comparePriceCents: p.comparePriceCents,
    yearlyPriceCents: p.yearlyPriceCents,
    currency: p.currency,
    interval: p.interval,
    features: p.features,
    limits: p.limits,
    ctaLabel: p.ctaLabel,
    highlight: p.highlight,
    comingSoon: p.comingSoon,
  }));
  return json({ ok: true, plans }, 200, { 'Cache-Control': 'public, max-age=60' });
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET');
