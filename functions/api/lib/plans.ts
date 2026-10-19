import type { D1Database } from '@cloudflare/workers-types';

/**
 * Plans and quotas: the ONE place that knows what each subscription includes.
 * Source of truth: ECONOMY_AND_FINANCE.md §2. Change a number there, change it here, nowhere else.
 *
 * Money is kept in micro-dollars (1 USD = 1_000_000) so $0.015 stays an exact integer.
 */

/** 'free' | 'api' | 'pro' are built in; plans made in /admin → Plans add their own ids. */
export type PlanId = string;
export type SubscriptionStatus = 'active' | 'past_due' | 'canceled';

const USD = 1_000_000;

export interface PlanSpec {
  id: PlanId;
  label: string;
  /** true: the quota is for the whole life of the account (Free Trial), false: it resets every month */
  lifetime: boolean;
  /** posts a month made in the dashboard (UI) */
  ui: number;
  /** API posts a month */
  api: number;
  /** when set, UI and API posts share ONE total (Free Trial: "30 posts in total") */
  shared: number | null;
  /** can this plan send live API requests on its own? (Pro needs the API Add-on) */
  apiIncluded: boolean;
  /** price per post beyond the quota, in micro-USD; null = never billed, the plan simply stops */
  overage: { post: number; aiPost: number } | null;
  /** connected channels in the dashboard; null = unlimited */
  channels: number | null;
  /** AI credits the plan includes (free utilities are not counted) */
  aiCredits: number | null;
}

/**
 * The plans the engine knows. These built-in numbers are the defaults; the `plans` table (edited in /admin → Plans)
 * overrides and extends them at runtime, see refreshPlanSpecs() below. Always read it through specOf().
 */
export const PLANS: Record<string, PlanSpec> = {
  // §2.1 — 30 posts in total, 2 channels, 10 AI credits, hard stop (never charged)
  free: { id: 'free', label: 'Free Trial', lifetime: true, ui: 0, api: 0, shared: 30, apiIncluded: true, overage: null, channels: 2, aiCredits: 10 },
  // §2.2 — $5.99: 180 API posts a month; overage $0.03 / $0.09 per AI post
  api: { id: 'api', label: 'Developer API', lifetime: false, ui: 0, api: 180, shared: null, apiIncluded: true, overage: { post: 0.03 * USD, aiPost: 0.09 * USD }, channels: null, aiCredits: null },
  // §2.4 — $9.99 Early Bird / $12: 1,000 dashboard posts a month; overage $0.015 / $0.045 per AI post
  pro: { id: 'pro', label: 'Pro Dashboard', lifetime: false, ui: 1000, api: 0, shared: null, apiIncluded: false, overage: { post: 0.015 * USD, aiPost: 0.045 * USD }, channels: null, aiCredits: 250 },
};

/** §2.5 — Pro + API Add-on: +180 API posts a month, with Pro's overage rates. */
export const API_ADDON_POSTS = 180;
let addonPosts = API_ADDON_POSTS;

/** The spec of a plan id; an unknown id (a plan that was removed) is served the Free Trial limits. */
export const specOf = (id: string): PlanSpec => PLANS[id] ?? PLANS.free;

/**
 * How many quota units one accepted API request costs.
 * One request = one post, however many channels it targets (a multi-channel post is still "one post").
 * If that ever changes to "per delivery", this is the only line to touch.
 */
export const postUnits = (_channelCount: number): number => 1;

// ───────────────────────── subscription ─────────────────────────

/** The columns of `subscriptions`, as they come out of D1 (all nullable here: a user may have no row). */
export interface SubscriptionRow {
  plan: PlanId | null;
  api_addon: number | null;
  status: SubscriptionStatus | null;
  current_period_end: number | null;
  overage_enabled: number | null;
}

export interface Subscription {
  /** the plan that applies RIGHT NOW (a lapsed paid plan has already fallen back to 'free') */
  plan: PlanId;
  apiAddon: boolean;
  overageEnabled: boolean;
  status: SubscriptionStatus;
  currentPeriodEnd: number | null;
  /** a paid plan that stopped being active: we serve the Free Trial limits until a payment renews it */
  lapsed: boolean;
}

export const FREE_SUBSCRIPTION: Subscription = {
  plan: 'free', apiAddon: false, overageEnabled: false, status: 'active', currentPeriodEnd: null, lapsed: false,
};

/** Turns a stored row (or none) into the plan that applies at `now`. */
export function resolveSubscription(row: SubscriptionRow | null | undefined, now: number): Subscription {
  if (!row || !row.plan) return FREE_SUBSCRIPTION;
  const status = row.status ?? 'active';
  const expired = row.current_period_end !== null && row.current_period_end <= now;
  if (!PLANS[row.plan] || (row.plan !== 'free' && (status !== 'active' || expired))) {
    return { ...FREE_SUBSCRIPTION, status, currentPeriodEnd: row.current_period_end, lapsed: true };
  }
  return {
    plan: row.plan,
    apiAddon: row.api_addon === 1,
    overageEnabled: row.overage_enabled === 1,
    status,
    currentPeriodEnd: row.current_period_end,
    lapsed: false,
  };
}

/** Quota limits for the subscription. `shared` is set only on the Free Trial. */
export function limitsFor(sub: Subscription): { ui: number; api: number; shared: number | null } {
  const spec = specOf(sub.plan);
  const addon = sub.plan === 'pro' && sub.apiAddon ? addonPosts : 0;
  return { ui: spec.ui, api: spec.api + addon, shared: spec.shared };
}

/** May this subscription send LIVE API requests? (Test-mode keys are always allowed.) */
export function apiAllowed(sub: Subscription): boolean {
  return specOf(sub.plan).apiIncluded || (sub.plan === 'pro' && sub.apiAddon);
}

/**
 * How a plan pays for AI generations (the free tools are never counted):
 *   credits          `aiCredits` of them are included (Free Trial 10 for life, Pro 250 a month); beyond that the plan's overage rate
 *                    applies when overage billing is on, otherwise it stops
 *   per_generation   no credits but an AI price (Developer API $0.09): every generation is billed, so overage billing must be on
 *   unlimited        an admin-made plan with the field left empty: counted, never blocked
 */
export type AiMode = { kind: 'credits'; credits: number } | { kind: 'per_generation'; priceMicro: number } | { kind: 'unlimited' };
export function aiMode(spec: PlanSpec): AiMode {
  if (spec.aiCredits !== null) return { kind: 'credits', credits: spec.aiCredits };
  if (spec.overage && spec.overage.aiPost > 0) return { kind: 'per_generation', priceMicro: spec.overage.aiPost };
  return { kind: 'unlimited' };
}

/** Overage rates that apply to this subscription, or null when it can never go over (it just stops). */
export function overageRates(sub: Subscription): { post: number; aiPost: number } | null {
  return sub.overageEnabled ? specOf(sub.plan).overage : null;
}

// ───────────────────────── billing period ─────────────────────────

/** 'lifetime' for the Free Trial, otherwise the UTC month: '2026-10'. */
export function periodKey(plan: PlanId, nowSeconds: number): string {
  if (specOf(plan).lifetime) return 'lifetime';
  const d = new Date(nowSeconds * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Unix seconds when the quota resets, or null for a lifetime quota. */
export function periodResetsAt(plan: PlanId, nowSeconds: number): number | null {
  if (specOf(plan).lifetime) return null;
  const d = new Date(nowSeconds * 1000);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000);
}

export const microToUsd = (micro: number): number => Math.round(micro) / USD;

// ───────────────────────── catalog (edited in /admin → Plans) ─────────────────────────
// A plan's `limits` JSON is turned into a PlanSpec, so a price-list edit in the admin changes what the engine enforces.
//   postsLifetime  → a trial-style quota for the whole life of the account (UI + API share it)
//   postsPerMonth  → dashboard posts a month        apiPostsPerMonth → API posts a month   (missing = 0, i.e. none)
//   channels, aiCredits → missing = unlimited       apiAccess 1/0 → may use live API keys (default: yes when it has API posts)
//   overagePostUsd / overageAiPostUsd → price per extra post (missing = the plan simply stops)
// The row with kind 'addon' and id 'api-addon' sets the add-on's extra API posts.
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function specFromCatalog(id: string, label: string, limits: Record<string, unknown>): PlanSpec {
  const life = num(limits.postsLifetime);
  const api = num(limits.apiPostsPerMonth) ?? 0;
  const ui = num(limits.postsPerMonth) ?? 0;
  const op = num(limits.overagePostUsd);
  const oa = num(limits.overageAiPostUsd);
  const access = num(limits.apiAccess);
  return {
    id, label,
    lifetime: life !== null,
    ui: life !== null ? 0 : ui,
    api: life !== null ? 0 : api,
    shared: life,
    apiIncluded: access !== null ? access === 1 : life !== null || api > 0,
    overage: op !== null || oa !== null ? { post: Math.round((op ?? oa ?? 0) * USD), aiPost: Math.round((oa ?? op ?? 0) * USD) } : null,
    channels: num(limits.channels),
    aiCredits: num(limits.aiCredits),
  };
}

const BUILTIN: Record<string, PlanSpec> = { ...PLANS };
let loadedAt = 0;

/** Reloads the specs from the plans table (cached 15 s per isolate). Call before reading PLANS in a request. */
export async function refreshPlanSpecs(env: { DB: D1Database }): Promise<void> {
  if (Date.now() - loadedAt < 15_000) return;
  loadedAt = Date.now(); // set first: a failing query is not retried on every request
  try {
    const { results } = await env.DB.prepare('SELECT id, kind, name, limits FROM plans').all<{ id: string; kind: string; name: string; limits: string }>();
    const next: Record<string, PlanSpec> = { ...BUILTIN };
    let addon = API_ADDON_POSTS;
    for (const r of results) {
      let limits: Record<string, unknown> = {};
      try { limits = JSON.parse(r.limits) as Record<string, unknown>; } catch { /* corrupt row: no limits */ }
      if (r.kind === 'addon') {
        if (r.id === 'api-addon') addon = num(limits.apiPostsPerMonth) ?? addon;
        continue;
      }
      next[r.id] = specFromCatalog(r.id, r.name, limits);
    }
    for (const k of Object.keys(PLANS)) delete PLANS[k];
    Object.assign(PLANS, next);
    addonPosts = addon;
  } catch {
    /* plans table missing (schema not applied yet): the built-in numbers stay */
  }
}

/** After an admin edit: the next request in this isolate reloads immediately. */
export const invalidatePlanSpecs = (): void => {
  loadedAt = 0;
};
