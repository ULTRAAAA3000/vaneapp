/**
 * Plans and quotas: the ONE place that knows what each subscription includes.
 * Source of truth: ECONOMY_AND_FINANCE.md §2. Change a number there, change it here, nowhere else.
 *
 * Money is kept in micro-dollars (1 USD = 1_000_000) so $0.015 stays an exact integer.
 */

export type PlanId = 'free' | 'api' | 'pro';
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

export const PLANS: Record<PlanId, PlanSpec> = {
  // §2.1 — 30 posts in total, 2 channels, 10 AI credits, hard stop (never charged)
  free: { id: 'free', label: 'Free Trial', lifetime: true, ui: 0, api: 0, shared: 30, apiIncluded: true, overage: null, channels: 2, aiCredits: 10 },
  // §2.2 — $5.99: 180 API posts a month; overage $0.03 / $0.09 per AI post
  api: { id: 'api', label: 'Developer API', lifetime: false, ui: 0, api: 180, shared: null, apiIncluded: true, overage: { post: 0.03 * USD, aiPost: 0.09 * USD }, channels: null, aiCredits: null },
  // §2.4 — $9.99 Early Bird / $12: 1,000 dashboard posts a month; overage $0.015 / $0.045 per AI post
  pro: { id: 'pro', label: 'Pro Dashboard', lifetime: false, ui: 1000, api: 0, shared: null, apiIncluded: false, overage: { post: 0.015 * USD, aiPost: 0.045 * USD }, channels: null, aiCredits: 250 },
};

/** §2.5 — Pro + API Add-on: +180 API posts a month, with Pro's overage rates. */
export const API_ADDON_POSTS = 180;

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
  if (row.plan !== 'free' && (status !== 'active' || expired)) {
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
  const spec = PLANS[sub.plan];
  const addon = sub.plan === 'pro' && sub.apiAddon ? API_ADDON_POSTS : 0;
  return { ui: spec.ui, api: spec.api + addon, shared: spec.shared };
}

/** May this subscription send LIVE API requests? (Test-mode keys are always allowed.) */
export function apiAllowed(sub: Subscription): boolean {
  return PLANS[sub.plan].apiIncluded || (sub.plan === 'pro' && sub.apiAddon);
}

/** Overage rates that apply to this subscription, or null when it can never go over (it just stops). */
export function overageRates(sub: Subscription): { post: number; aiPost: number } | null {
  return sub.overageEnabled ? PLANS[sub.plan].overage : null;
}

// ───────────────────────── billing period ─────────────────────────

/** 'lifetime' for the Free Trial, otherwise the UTC month: '2026-10'. */
export function periodKey(plan: PlanId, nowSeconds: number): string {
  if (PLANS[plan].lifetime) return 'lifetime';
  const d = new Date(nowSeconds * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Unix seconds when the quota resets, or null for a lifetime quota. */
export function periodResetsAt(plan: PlanId, nowSeconds: number): number | null {
  if (PLANS[plan].lifetime) return null;
  const d = new Date(nowSeconds * 1000);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000);
}

export const microToUsd = (micro: number): number => Math.round(micro) / USD;
