/**
 * Metered usage: what the account has used, and the gate that enforces the quota.
 *
 * The gate is a SINGLE conditional upsert on usage_counters (see reserveApiPost). Reading the counter and
 * then writing it would let two parallel requests both take the last unit; one statement cannot.
 */
import type { D1PreparedStatement } from '@cloudflare/workers-types';
import type { Env, UsageBucket, UsageSummary } from '../../../types';
import {
  aiMode, aiPassOffer, apiAllowed, limitsFor, microToUsd, overageRates, periodKey, periodResetsAt, refreshPlanSpecs, resolveSubscription, specOf,
  type PlanSpec, type Subscription, type SubscriptionRow,
} from './plans';
import { loadAiPass, passPeriod, type AiPassState } from './aipass';

export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

export async function loadSubscription(env: Env, userId: string, now = nowSeconds()): Promise<Subscription> {
  await refreshPlanSpecs(env); // limits come from the plans table (admin → Plans)
  const row = await env.DB
    .prepare('SELECT plan, api_addon, status, current_period_end, overage_enabled FROM subscriptions WHERE user_id = ?1')
    .bind(userId)
    .first<SubscriptionRow>();
  return resolveSubscription(row, now);
}

interface Counters {
  api_posts: number;
  ui_posts: number;
  ai_generations: number;
  overage_posts: number;
  overage_micro_usd: number;
}

async function loadCounters(env: Env, userId: string, period: string): Promise<Counters> {
  const row = await env.DB
    .prepare('SELECT api_posts, ui_posts, ai_generations, overage_posts, overage_micro_usd FROM usage_counters WHERE user_id = ?1 AND period = ?2')
    .bind(userId, period)
    .first<Counters>();
  return row ?? { api_posts: 0, ui_posts: 0, ai_generations: 0, overage_posts: 0, overage_micro_usd: 0 };
}

const bucket = (limit: number, used: number): UsageBucket => ({ limit, used, remaining: Math.max(limit - used, 0) });

/** Price of one extra AI credit for this account, in micro-USD: the cheaper of the plan's rate and the AI Pass rate; null = nothing to pay for. */
export function aiExtraRate(spec: PlanSpec, passActive: boolean): number | null {
  const rates = [spec.overage && spec.overage.aiPost > 0 ? spec.overage.aiPost : null, passActive ? aiPassOffer().overageMicro : null].filter((r): r is number => r !== null);
  return rates.length ? Math.min(...rates) : null;
}

/** AI credits as the dashboard shows them. See aiMode() for how a plan's `aiCredits` is read. */
function aiBucket(spec: PlanSpec, sub: Subscription, used: number, bonus: number, pass: AiPassState): UsageSummary['ai'] {
  const mode = aiMode(spec);
  const offer = aiPassOffer();
  const passCredits = pass.active ? offer.credits : 0;
  const passLeft = Math.max(passCredits - pass.used, 0);
  const rate = aiExtraRate(spec, pass.active);
  const extraOn = sub.overageEnabled && rate !== null;
  const planLeft = mode.kind === 'credits' ? Math.max(mode.credits - used, 0) : 0;
  const remaining = mode.kind === 'unlimited' ? null : planLeft + passLeft + bonus;
  return {
    limit: mode.kind === 'credits' ? mode.credits : null,
    used,
    remaining,
    perGenerationUsd: mode.kind === 'per_generation' ? microToUsd(mode.priceMicro) : null,
    billable: mode.kind === 'unlimited' || (remaining ?? 0) > 0 || extraOn,
    bonus,
    pass: { active: pass.active, credits: passCredits, used: pass.used, remaining: passLeft, endsAt: pass.endsAt },
    offer: !pass.active && offer.active ? { priceUsd: offer.priceCents / 100, credits: offer.credits, interval: offer.interval, overageUsd: offer.overageMicro !== null ? microToUsd(offer.overageMicro) : null } : null,
    extra: { enabled: sub.overageEnabled, rateUsd: rate !== null ? microToUsd(rate) : null },
  };
}

/** Credits an admin gave to this account (0 when none, or when the table is not there yet). */
export async function loadAiBonus(env: Env, userId: string): Promise<number> {
  try {
    const row = await env.DB.prepare('SELECT credits FROM user_ai_bonus WHERE user_id = ?1').bind(userId).first<{ credits: number }>();
    return row?.credits ?? 0;
  } catch { return 0; }
}

/** The full picture for `GET /api/usage` and `GET /api/v1/usage`. */
export async function usageSummary(env: Env, userId: string, sub: Subscription, now = nowSeconds()): Promise<UsageSummary> {
  const spec = specOf(sub.plan);
  const period = periodKey(sub.plan, now);
  const c = await loadCounters(env, userId, period);
  const lim = limitsFor(sub);
  const rates = overageRates(sub);

  // Free Trial: UI and API posts draw from ONE total.
  const shared = lim.shared !== null ? bucket(lim.shared, c.api_posts + c.ui_posts) : null;
  return {
    plan: {
      id: sub.plan, label: spec.label, status: sub.status, lapsed: sub.lapsed, apiAddon: sub.apiAddon,
      currentPeriodEnd: sub.currentPeriodEnd,
    },
    period: { key: period, resetsAt: periodResetsAt(sub.plan, now) },
    api: shared ?? bucket(lim.api, c.api_posts),
    ui: shared ?? bucket(lim.ui, c.ui_posts),
    shared,
    ai: aiBucket(spec, sub, c.ai_generations, await loadAiBonus(env, userId), await loadAiPass(env, userId, now)),
    apiAccess: apiAllowed(sub),
    overage: {
      enabled: rates !== null,
      postUsd: spec.overage ? microToUsd(spec.overage.post) : null,
      aiPostUsd: spec.overage ? microToUsd(spec.overage.aiPost) : null,
      posts: c.overage_posts,
      costUsd: microToUsd(c.overage_micro_usd),
    },
  };
}

// ───────────────────────── the quota gate ─────────────────────────

export type Reservation =
  | { ok: true; overage: boolean; costMicro: number; period: string }
  | { ok: false; code: 'api_not_in_plan' | 'quota_exceeded' };

/**
 * Takes `units` from the API quota, or says why it can't.
 * Within the quota          → counted, free.
 * Over it, overage enabled  → counted AND priced (overage_posts / overage_micro_usd), e.g. $0.03 on the Developer API.
 * Over it, overage disabled → { ok: false, code: 'quota_exceeded' }  (the caller answers 402).
 */
export async function reserveApiPost(env: Env, userId: string, sub: Subscription, now: number, units: number): Promise<Reservation> {
  if (!apiAllowed(sub)) return { ok: false, code: 'api_not_in_plan' };

  const lim = limitsFor(sub);
  const period = periodKey(sub.plan, now);
  const cap = lim.shared ?? lim.api;

  // `used` is either the API counter or the shared total. Both fragments are constants (never user input).
  const used = lim.shared !== null ? '(api_posts + ui_posts)' : 'api_posts';

  if (cap >= units) {
    // The WHERE on DO UPDATE makes this all-or-nothing: no row change means the quota was already full.
    const res = await env.DB
      .prepare(
        `INSERT INTO usage_counters (user_id, period, api_posts, updated_at) VALUES (?1, ?2, ?5, ?3)
         ON CONFLICT(user_id, period) DO UPDATE SET api_posts = api_posts + ?5, updated_at = ?3
         WHERE ${used} + ?5 <= ?4`,
      )
      .bind(userId, period, now, cap, units)
      .run();
    if ((res.meta?.changes ?? 0) > 0) return { ok: true, overage: false, costMicro: 0, period };
  }

  const rates = overageRates(sub);
  if (!rates) return { ok: false, code: 'quota_exceeded' };

  const costMicro = Math.round(rates.post * units);
  await env.DB
    .prepare(
      `INSERT INTO usage_counters (user_id, period, api_posts, overage_posts, overage_micro_usd, updated_at) VALUES (?1, ?2, ?5, ?5, ?4, ?3)
       ON CONFLICT(user_id, period) DO UPDATE SET
         api_posts = api_posts + ?5, overage_posts = overage_posts + ?5, overage_micro_usd = overage_micro_usd + ?4, updated_at = ?3`,
    )
    .bind(userId, period, now, costMicro, units)
    .run();
  return { ok: true, overage: true, costMicro, period };
}

/** Gives a reservation back (the post could not be saved after all). */
export async function releaseApiPost(env: Env, userId: string, r: Extract<Reservation, { ok: true }>, units: number): Promise<void> {
  try {
    await env.DB
      .prepare(
        `UPDATE usage_counters SET
           api_posts = MAX(api_posts - ?3, 0),
           overage_posts = MAX(overage_posts - ?4, 0),
           overage_micro_usd = MAX(overage_micro_usd - ?5, 0),
           updated_at = ?6
         WHERE user_id = ?1 AND period = ?2`,
      )
      .bind(userId, r.period, units, r.overage ? units : 0, r.costMicro, nowSeconds())
      .run();
  } catch (err) {
    // Not fatal: the user is at worst charged one unit too many, and the failure is visible in the logs.
    console.error('quota release failed', err instanceof Error ? err.message : 'unknown');
  }
}

/**
 * Dashboard posts are counted (the Free Trial total is shared with the API) but not blocked yet.
 * Deliberately tolerant: counting must never be the reason a post fails, e.g. while the usage tables are
 * not in the database yet (right after a deploy, before `npm run db:remote`).
 */
export async function countUiPosts(env: Env, userId: string, units: number): Promise<void> {
  try {
    const now = nowSeconds();
    const sub = await loadSubscription(env, userId, now);
    await env.DB
      .prepare(
        `INSERT INTO usage_counters (user_id, period, ui_posts, updated_at) VALUES (?1, ?2, ?4, ?3)
         ON CONFLICT(user_id, period) DO UPDATE SET ui_posts = ui_posts + ?4, updated_at = ?3`,
      )
      .bind(userId, periodKey(sub.plan, now), now, units)
      .run();
  } catch (err) {
    console.error('ui usage count failed', err instanceof Error ? err.message : 'unknown');
  }
}

/** One audit row per metered API call. Meant to be batched together with the rows it describes. */
export function usageLogStatement(
  env: Env,
  e: { userId: string; keyId: string | null; units: number; overage: boolean; costMicro: number; ref: string | null; now: number },
): D1PreparedStatement {
  return env.DB
    .prepare(
      `INSERT INTO usage_logs (user_id, api_key_id, source, kind, units, overage, cost_micro_usd, ref, created_at)
       VALUES (?1, ?2, 'api', 'post', ?3, ?4, ?5, ?6, ?7)`,
    )
    .bind(e.userId, e.keyId, e.units, e.overage ? 1 : 0, e.costMicro, e.ref, e.now);
}

/** Headers that let no-code tools (Make, Zapier) read the quota without parsing the body. */
export function quotaHeaders(u: UsageSummary): Record<string, string> {
  const h: Record<string, string> = {
    'X-Vane-Quota-Limit': String(u.api.limit),
    'X-Vane-Quota-Remaining': String(u.api.remaining),
  };
  if (u.period.resetsAt !== null) h['X-Vane-Quota-Reset'] = String(u.period.resetsAt);
  return h;
}

// ───────────────────────── AI generations ─────────────────────────

export type AiSource = 'plan' | 'pass' | 'bonus' | 'extra' | 'unlimited';
export type AiReservation =
  | { ok: true; overage: boolean; costMicro: number; period: string; source: AiSource }
  | { ok: false; code: 'ai_not_in_plan' | 'ai_quota_exceeded' };

/**
 * Takes one AI generation, or says why it can't. Same single-statement guard as reserveApiPost. Where a credit comes from, in this order:
 *   1. the plan's own credits (Free Trial 10 for life, Pro 250 a month)
 *   2. the AI Pass (monthly credits on top of any plan)
 *   3. credits an admin gave to the account
 *   4. an extra credit, paid per generation: only when the account switched "pay for extra" on (and the plan or the pass has a price)
 * Otherwise it is refused. A plan with no credit limit at all ('unlimited') is counted and never stopped.
 */
export async function reserveAiGeneration(env: Env, userId: string, sub: Subscription, now: number): Promise<AiReservation> {
  const spec = specOf(sub.plan);
  const mode = aiMode(spec);
  const period = periodKey(sub.plan, now);

  if (mode.kind === 'credits' && mode.credits >= 1) {
    const res = await env.DB
      .prepare(
        `INSERT INTO usage_counters (user_id, period, ai_generations, updated_at) VALUES (?1, ?2, 1, ?3)
         ON CONFLICT(user_id, period) DO UPDATE SET ai_generations = ai_generations + 1, updated_at = ?3
         WHERE ai_generations + 1 <= ?4`,
      )
      .bind(userId, period, now, mode.credits)
      .run();
    if ((res.meta?.changes ?? 0) > 0) return { ok: true, overage: false, costMicro: 0, period, source: 'plan' };
  }
  if (mode.kind === 'unlimited') {
    await env.DB
      .prepare(`INSERT INTO usage_counters (user_id, period, ai_generations, updated_at) VALUES (?1, ?2, 1, ?3)
                ON CONFLICT(user_id, period) DO UPDATE SET ai_generations = ai_generations + 1, updated_at = ?3`)
      .bind(userId, period, now)
      .run();
    return { ok: true, overage: false, costMicro: 0, period, source: 'unlimited' };
  }

  const pass = await loadAiPass(env, userId, now);
  if (pass.active && aiPassOffer().credits >= 1) {
    const res = await env.DB
      .prepare(
        `INSERT INTO ai_pass_usage (user_id, period, used) VALUES (?1, ?2, 1)
         ON CONFLICT(user_id, period) DO UPDATE SET used = used + 1 WHERE used + 1 <= ?3`,
      )
      .bind(userId, passPeriod(now), aiPassOffer().credits)
      .run();
    if ((res.meta?.changes ?? 0) > 0) return { ok: true, overage: false, costMicro: 0, period: passPeriod(now), source: 'pass' };
  }
  try {
    const b = await env.DB.prepare('UPDATE user_ai_bonus SET credits = credits - 1, updated_at = ?2 WHERE user_id = ?1 AND credits > 0').bind(userId, now).run();
    if ((b.meta?.changes ?? 0) > 0) return { ok: true, overage: false, costMicro: 0, period, source: 'bonus' };
  } catch { /* the table is not there yet (schema.sql not re-run): no bonus */ }

  const rate = aiExtraRate(spec, pass.active);
  if (!sub.overageEnabled || rate === null) {
    const hadCredits = (mode.kind === 'credits' && mode.credits >= 1) || pass.active;
    return { ok: false, code: hadCredits ? 'ai_quota_exceeded' : 'ai_not_in_plan' };
  }
  await env.DB
    .prepare(
      `INSERT INTO usage_counters (user_id, period, ai_generations, overage_micro_usd, updated_at) VALUES (?1, ?2, 1, ?4, ?3)
       ON CONFLICT(user_id, period) DO UPDATE SET ai_generations = ai_generations + 1, overage_micro_usd = overage_micro_usd + ?4, updated_at = ?3`,
    )
    .bind(userId, period, now, rate)
    .run();
  return { ok: true, overage: true, costMicro: rate, period, source: 'extra' };
}

/** The generation failed on our side (the model did not answer): give the credit back where it came from. */
export async function releaseAiGeneration(env: Env, userId: string, r: Extract<AiReservation, { ok: true }>): Promise<void> {
  try {
    if (r.source === 'bonus') {
      await env.DB.prepare('UPDATE user_ai_bonus SET credits = credits + 1 WHERE user_id = ?1').bind(userId).run();
    } else if (r.source === 'pass') {
      await env.DB.prepare('UPDATE ai_pass_usage SET used = MAX(used - 1, 0) WHERE user_id = ?1 AND period = ?2').bind(userId, r.period).run();
    } else {
      await env.DB
        .prepare(
          `UPDATE usage_counters SET ai_generations = MAX(ai_generations - 1, 0), overage_micro_usd = MAX(overage_micro_usd - ?3, 0), updated_at = ?4
           WHERE user_id = ?1 AND period = ?2`,
        )
        .bind(userId, r.period, r.costMicro, nowSeconds())
        .run();
    }
  } catch (err) {
    console.error('ai credit release failed', err instanceof Error ? err.message : 'unknown');
  }
}

/** One row in the usage log per paid generation (admin → Plans reads it like the post rows). */
export function aiLogStatement(env: Env, e: { userId: string; overage: boolean; costMicro: number; ref: string; now: number }): D1PreparedStatement {
  return env.DB
    .prepare(
      `INSERT INTO usage_logs (user_id, api_key_id, source, kind, units, overage, cost_micro_usd, ref, created_at)
       VALUES (?1, NULL, 'ui', 'ai_post', 1, ?2, ?3, ?4, ?5)`,
    )
    .bind(e.userId, e.overage ? 1 : 0, e.costMicro, e.ref, e.now);
}
