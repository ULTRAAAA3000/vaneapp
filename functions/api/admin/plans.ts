/**
 * GET    /api/admin/plans            → every plan (also hidden / switched-off ones) with subscriber counts
 * POST   /api/admin/plans            → create   { id, name, priceCents, … }
 * PUT    /api/admin/plans?id=pro     → edit any subset of fields
 * DELETE /api/admin/plans?id=ultra   → only when nobody ever had it; otherwise switch it off instead
 *
 * Prices are integer cents. The landing page and the plan limits read this table directly,
 * so a change here is live as soon as the 60 s public cache expires.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { audit, requireAdmin } from '../lib/admin';
import { fail, isRecord, json, methodNotAllowed, readJson } from '../lib/http';
import { invalidatePlanSpecs } from '../lib/plans';
import { getPlan, listPlans, validatePlanInput, type PlanInput } from '../lib/catalog';

const COLUMN: Record<string, string> = {
  kind: 'kind', name: 'name', tagline: 'tagline', badge: 'badge', priceCents: 'price_cents', comparePriceCents: 'compare_price_cents',
  yearlyPriceCents: 'yearly_price_cents', currency: 'currency', interval: 'interval', trialDays: 'trial_days', features: 'features',
  limits: 'limits', ctaLabel: 'cta_label', highlight: 'highlight', comingSoon: 'coming_soon', isPublic: 'is_public', isActive: 'is_active',
  sort: 'sort', providerRefs: 'provider_refs',
};
const JSON_FIELDS = new Set(['features', 'limits', 'providerRefs']);
const BOOL_FIELDS = new Set(['highlight', 'comingSoon', 'isPublic', 'isActive']);
const dbValue = (k: string, v: unknown): unknown => (JSON_FIELDS.has(k) ? JSON.stringify(v) : BOOL_FIELDS.has(k) ? (v ? 1 : 0) : v);

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;
  const now = Math.floor(Date.now() / 1000);
  const [plans, counts, total] = await Promise.all([
    listPlans(env),
    env.DB
      .prepare(`SELECT plan AS plan_id, COUNT(*) n, COALESCE(SUM(provider <> 'manual'),0) paid FROM subscriptions
                 WHERE plan <> 'free' AND status = 'active' AND (current_period_end IS NULL OR current_period_end > ?1) GROUP BY plan`)
      .bind(now)
      .all<{ plan_id: string; n: number; paid: number }>(),
    env.DB.prepare('SELECT COUNT(*) n FROM users').first<{ n: number }>(),
  ]);
  const by = new Map(counts.results.map((c) => [c.plan_id, c]));
  const onFree = Math.max(0, (total?.n ?? 0) - counts.results.reduce((a, c) => a + c.n, 0));   // everybody without an active paid plan
  return json({ ok: true, plans: plans.map((p) => ({ ...p, activeSubscribers: p.id === 'free' ? onFree : by.get(p.id)?.n ?? 0, paidSubscribers: by.get(p.id)?.paid ?? 0 })) });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;
  const parsed = await readJson(request, 16_384);
  if (!parsed.ok) return parsed.response;
  if (!isRecord(parsed.data)) return fail(400, 'Body must be a JSON object');
  const v = validatePlanInput(parsed.data, true);
  if (!v.ok) return fail(400, v.error);
  if (await getPlan(env, v.value.id as string)) return fail(409, 'A plan with this id already exists.');

  const f: PlanInput = v.value;
  await env.DB
    .prepare(
      `INSERT INTO plans (id, kind, name, tagline, badge, price_cents, compare_price_cents, yearly_price_cents, currency, interval, trial_days,
                          features, limits, cta_label, highlight, coming_soon, is_public, is_active, sort, provider_refs)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)`,
    )
    .bind(
      f.id, f.kind ?? 'plan', f.name, f.tagline ?? '', f.badge ?? '', f.priceCents, f.comparePriceCents ?? null, f.yearlyPriceCents ?? null,
      f.currency ?? 'USD', f.interval ?? 'month', f.trialDays ?? 0, JSON.stringify(f.features ?? []), JSON.stringify(f.limits ?? {}),
      f.ctaLabel ?? 'Join the waitlist', f.highlight ? 1 : 0, f.comingSoon ? 1 : 0, f.isPublic === false ? 0 : 1, f.isActive === false ? 0 : 1,
      f.sort ?? 100, JSON.stringify(f.providerRefs ?? {}),
    )
    .run();
  invalidatePlanSpecs();
  await audit(env, request, 'plan.create', f.id, { name: f.name, priceCents: f.priceCents });
  return json({ ok: true, plan: await getPlan(env, f.id as string) }, 201);
};

export const onRequestPut: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;
  const id = new URL(request.url).searchParams.get('id') ?? '';
  const current = await getPlan(env, id);
  if (!current) return fail(404, 'Plan not found.');
  const parsed = await readJson(request, 16_384);
  if (!parsed.ok) return parsed.response;
  if (!isRecord(parsed.data)) return fail(400, 'Body must be a JSON object');
  const { id: _ignored, ...rest } = parsed.data;
  void _ignored;
  const v = validatePlanInput(rest, false);
  if (!v.ok) return fail(400, v.error);
  const fields = Object.entries(v.value).filter(([, x]) => x !== undefined);
  if (!fields.length) return fail(400, 'Nothing to change.');
  if (id === 'free' && (v.value.isActive === false || (v.value.kind && v.value.kind !== 'plan'))) return fail(400, 'The Free plan must stay an active plan: it is what everybody without a subscription gets.');

  const sets = fields.map(([k], i) => `${COLUMN[k]} = ?${i + 2}`);
  await env.DB
    .prepare(`UPDATE plans SET ${sets.join(', ')}, updated_at = unixepoch() WHERE id = ?1`)
    .bind(id, ...fields.map(([k, x]) => dbValue(k, x)))
    .run();
  invalidatePlanSpecs();
  const changed: Record<string, unknown> = {};
  for (const [k, x] of fields) changed[k] = { from: (current as unknown as Record<string, unknown>)[k], to: x };
  await audit(env, request, 'plan.update', id, changed);
  return json({ ok: true, plan: await getPlan(env, id) });
};

export const onRequestDelete: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;
  const id = new URL(request.url).searchParams.get('id') ?? '';
  if (id === 'free') return fail(400, 'The Free plan cannot be deleted.');
  if (!(await getPlan(env, id))) return fail(404, 'Plan not found.');
  const used = await env.DB.prepare('SELECT COUNT(*) n FROM subscriptions WHERE plan = ?1').bind(id).first<{ n: number }>();
  if ((used?.n ?? 0) > 0) return fail(409, 'Somebody is (or was) on this plan, so it is kept. Switch it off (hide it and stop giving it) instead.');
  await env.DB.prepare('DELETE FROM plans WHERE id = ?1').bind(id).run();
  invalidatePlanSpecs();
  await audit(env, request, 'plan.delete', id);
  return json({ ok: true });
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET, POST, PUT, DELETE');
