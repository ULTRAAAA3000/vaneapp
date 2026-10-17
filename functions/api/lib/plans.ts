/** Plans, subscriptions and plan limits. Money amounts are integer cents. */
import type { Env } from '../../../types';
import { fail } from './http';
import { getSettings } from './settings';

export interface PlanLimits {
  channels?: number | null;
  postsPerMonth?: number | null;
  postsLifetime?: number | null;
  aiCredits?: number | null;
  apiPostsPerMonth?: number | null;
  seats?: number | null;
  overagePostUsd?: number | null;
  overageAiPostUsd?: number | null;
}
const LIMIT_KEYS: (keyof PlanLimits)[] = ['channels', 'postsPerMonth', 'postsLifetime', 'aiCredits', 'apiPostsPerMonth', 'seats', 'overagePostUsd', 'overageAiPostUsd'];
const FRACTIONAL = new Set<string>(['overagePostUsd', 'overageAiPostUsd']);

export interface Plan {
  id: string;
  kind: 'plan' | 'addon';
  name: string;
  tagline: string;
  badge: string;
  priceCents: number;
  comparePriceCents: number | null;
  yearlyPriceCents: number | null;
  currency: string;
  interval: 'month' | 'year' | 'once';
  trialDays: number;
  features: string[];
  limits: PlanLimits;
  ctaLabel: string;
  highlight: boolean;
  comingSoon: boolean;
  isPublic: boolean;
  isActive: boolean;
  sort: number;
  providerRefs: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

export interface PlanRow {
  id: string; kind: 'plan' | 'addon'; name: string; tagline: string; badge: string; price_cents: number;
  compare_price_cents: number | null; yearly_price_cents: number | null; currency: string;
  interval: 'month' | 'year' | 'once'; trial_days: number; features: string; limits: string; cta_label: string;
  highlight: number; coming_soon: number; is_public: number; is_active: number; sort: number;
  provider_refs: string; created_at: number; updated_at: number;
}

const parseJson = <T>(s: string, fallback: T): T => {
  try {
    const v: unknown = JSON.parse(s);
    return v === null || typeof v !== 'object' ? fallback : (v as T);
  } catch {
    return fallback;
  }
};

export function rowToPlan(r: PlanRow): Plan {
  return {
    id: r.id, kind: r.kind, name: r.name, tagline: r.tagline, badge: r.badge,
    priceCents: r.price_cents, comparePriceCents: r.compare_price_cents, yearlyPriceCents: r.yearly_price_cents,
    currency: r.currency, interval: r.interval, trialDays: r.trial_days,
    features: parseJson<string[]>(r.features, []), limits: parseJson<PlanLimits>(r.limits, {}),
    ctaLabel: r.cta_label, highlight: r.highlight === 1, comingSoon: r.coming_soon === 1,
    isPublic: r.is_public === 1, isActive: r.is_active === 1, sort: r.sort,
    providerRefs: parseJson<Record<string, string>>(r.provider_refs, {}),
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export async function listPlans(env: Env, opts: { publicOnly?: boolean } = {}): Promise<Plan[]> {
  const { results } = await env.DB
    .prepare(`SELECT * FROM plans ${opts.publicOnly ? 'WHERE is_public = 1' : ''} ORDER BY sort ASC, price_cents ASC`)
    .all<PlanRow>();
  return results.map(rowToPlan);
}

export async function getPlan(env: Env, id: string): Promise<Plan | null> {
  const r = await env.DB.prepare('SELECT * FROM plans WHERE id = ?1').bind(id).first<PlanRow>();
  return r ? rowToPlan(r) : null;
}

// ───────────────────────── validation (admin create / edit) ─────────────────────────
export interface PlanInput {
  id?: string; kind?: 'plan' | 'addon'; name?: string; tagline?: string; badge?: string;
  priceCents?: number; comparePriceCents?: number | null; yearlyPriceCents?: number | null;
  currency?: string; interval?: 'month' | 'year' | 'once'; trialDays?: number;
  features?: string[]; limits?: PlanLimits; ctaLabel?: string;
  highlight?: boolean; comingSoon?: boolean; isPublic?: boolean; isActive?: boolean; sort?: number;
  providerRefs?: Record<string, string>;
}

const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const isStr = (v: unknown, max: number, min = 0): v is string => typeof v === 'string' && v.length >= min && v.length <= max;
const MAX_CENTS = 10_000_000;

export function validatePlanInput(body: Record<string, unknown>, creating: boolean): { ok: true; value: PlanInput } | { ok: false; error: string } {
  const v: PlanInput = {};
  const bad = (m: string) => ({ ok: false as const, error: m });

  if (creating) {
    if (typeof body.id !== 'string' || !/^[a-z0-9][a-z0-9-]{1,30}$/.test(body.id)) return bad('id must be 2-31 characters: a-z, 0-9 and "-".');
    v.id = body.id;
  }
  if (body.kind !== undefined) { if (body.kind !== 'plan' && body.kind !== 'addon') return bad('kind must be "plan" or "addon".'); v.kind = body.kind; }
  if (body.name !== undefined || creating) { if (!isStr(body.name, 60, 1)) return bad('name is required (max 60 characters).'); v.name = body.name.trim(); if (!v.name) return bad('name is required.'); }
  if (body.tagline !== undefined) { if (!isStr(body.tagline, 240)) return bad('tagline is too long (max 240).'); v.tagline = body.tagline; }
  if (body.badge !== undefined) { if (!isStr(body.badge, 24)) return bad('badge is too long (max 24).'); v.badge = body.badge; }
  if (body.ctaLabel !== undefined) { if (!isStr(body.ctaLabel, 40, 1)) return bad('ctaLabel must be 1-40 characters.'); v.ctaLabel = body.ctaLabel; }
  if (body.priceCents !== undefined || creating) { if (!isInt(body.priceCents, 0, MAX_CENTS)) return bad('priceCents must be a whole number of cents (0 or more).'); v.priceCents = body.priceCents; }
  for (const k of ['comparePriceCents', 'yearlyPriceCents'] as const) {
    if (body[k] !== undefined) {
      if (body[k] !== null && !isInt(body[k], 0, MAX_CENTS)) return bad(`${k} must be cents or null.`);
      v[k] = body[k] as number | null;
    }
  }
  if (body.currency !== undefined) { if (typeof body.currency !== 'string' || !/^[A-Z]{3}$/.test(body.currency)) return bad('currency must be a 3-letter code like USD.'); v.currency = body.currency; }
  if (body.interval !== undefined) { if (body.interval !== 'month' && body.interval !== 'year' && body.interval !== 'once') return bad('interval must be month, year or once.'); v.interval = body.interval; }
  if (body.trialDays !== undefined) { if (!isInt(body.trialDays, 0, 365)) return bad('trialDays must be 0-365.'); v.trialDays = body.trialDays; }
  if (body.sort !== undefined) { if (!isInt(body.sort, -1000, 100000)) return bad('sort must be a whole number.'); v.sort = body.sort; }
  for (const k of ['highlight', 'comingSoon', 'isPublic', 'isActive'] as const) {
    if (body[k] !== undefined) { if (typeof body[k] !== 'boolean') return bad(`${k} must be true or false.`); v[k] = body[k] as boolean; }
  }
  if (body.features !== undefined) {
    if (!Array.isArray(body.features) || body.features.length > 20 || !body.features.every((f) => isStr(f, 160, 1))) return bad('features must be up to 20 lines of text (max 160 characters each).');
    v.features = (body.features as string[]).map((f) => f.trim()).filter(Boolean);
  }
  if (body.limits !== undefined) {
    if (typeof body.limits !== 'object' || body.limits === null || Array.isArray(body.limits)) return bad('limits must be an object.');
    const out: PlanLimits = {};
    for (const [k, val] of Object.entries(body.limits)) {
      if (!LIMIT_KEYS.includes(k as keyof PlanLimits)) return bad(`Unknown limit "${k}". Allowed: ${LIMIT_KEYS.join(', ')}.`);
      if (val === null) { (out as Record<string, unknown>)[k] = null; continue; }
      const ok = FRACTIONAL.has(k) ? typeof val === 'number' && Number.isFinite(val) && val >= 0 && val <= 1000 : isInt(val, 0, 100_000_000);
      if (!ok) return bad(`Limit "${k}" must be ${FRACTIONAL.has(k) ? 'a number' : 'a whole number'} (or empty for unlimited).`);
      (out as Record<string, unknown>)[k] = val;
    }
    v.limits = out;
  }
  if (body.providerRefs !== undefined) {
    const r = body.providerRefs;
    if (typeof r !== 'object' || r === null || Array.isArray(r) || Object.keys(r).length > 10 || !Object.values(r).every((x) => isStr(x, 120))) return bad('providerRefs must be a map of up to 10 short strings.');
    v.providerRefs = r as Record<string, string>;
  }
  return { ok: true, value: v };
}

// ───────────────────────── what a user is entitled to ─────────────────────────
interface SubJoin { sub_id: string; plan_id: string; ends_at: number | null; source: string }

export interface Effective {
  plan: Plan;
  subscription: { id: string; source: string; endsAt: number | null } | null;
}

const FALLBACK_FREE: Plan = {
  id: 'free', kind: 'plan', name: 'Free Trial', tagline: '', badge: '', priceCents: 0, comparePriceCents: null, yearlyPriceCents: null,
  currency: 'USD', interval: 'month', trialDays: 0, features: [], limits: { channels: 2, postsLifetime: 30, aiCredits: 10 },
  ctaLabel: 'Join the waitlist', highlight: false, comingSoon: false, isPublic: true, isActive: true, sort: 10, providerRefs: {}, createdAt: 0, updatedAt: 0,
};

/** The best active, unexpired plan wins (highest price); no subscription = Free. */
export async function effectivePlan(env: Env, userId: string): Promise<Effective> {
  const now = Math.floor(Date.now() / 1000);
  const s = await env.DB
    .prepare(
      `SELECT s.id AS sub_id, s.plan_id, s.ends_at, s.source
         FROM subscriptions s JOIN plans p ON p.id = s.plan_id
        WHERE s.user_id = ?1 AND s.status = 'active' AND (s.ends_at IS NULL OR s.ends_at > ?2) AND p.kind = 'plan'
        ORDER BY p.price_cents DESC, s.started_at DESC LIMIT 1`,
    )
    .bind(userId, now)
    .first<SubJoin>();
  if (s) {
    const plan = await getPlan(env, s.plan_id);
    if (plan) return { plan, subscription: { id: s.sub_id, source: s.source, endsAt: s.ends_at } };
  }
  return { plan: (await getPlan(env, 'free')) ?? FALLBACK_FREE, subscription: null };
}

const monthStart = (): number => {
  const d = new Date();
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000);
};

const over = (plan: Plan, what: string): Response => fail(402, `Your ${plan.name} plan ${what}. Upgrade to continue.`);

/** null = allowed. Does nothing while the "enforce_limits" switch is off. */
export async function checkChannelQuota(env: Env, userId: string): Promise<Response | null> {
  if (!(await getSettings(env)).enforce_limits) return null;
  const { plan } = await effectivePlan(env, userId);
  const max = plan.limits.channels;
  if (typeof max !== 'number') return null;
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM channels WHERE user_id = ?1').bind(userId).first<{ n: number }>();
  return (r?.n ?? 0) >= max ? over(plan, `allows ${max} connected channel${max === 1 ? '' : 's'}`) : null;
}

/** One request creates ONE post group (however many channels it targets). */
export async function checkPostQuota(env: Env, userId: string): Promise<Response | null> {
  if (!(await getSettings(env)).enforce_limits) return null;
  const { plan } = await effectivePlan(env, userId);
  const { postsLifetime, postsPerMonth } = plan.limits;
  const count = async (since: number): Promise<number> => {
    const r = await env.DB
      .prepare(`SELECT COUNT(DISTINCT group_id) AS n FROM posts WHERE user_id = ?1 AND created_at >= ?2 AND status NOT IN ('cancelled', 'draft')`)
      .bind(userId, since)
      .first<{ n: number }>();
    return r?.n ?? 0;
  };
  if (typeof postsLifetime === 'number' && (await count(0)) >= postsLifetime) return over(plan, `includes ${postsLifetime} posts in total, and you have used them all`);
  if (typeof postsPerMonth === 'number' && (await count(monthStart())) >= postsPerMonth) return over(plan, `includes ${postsPerMonth} posts a month, and you have used them all`);
  return null;
}
