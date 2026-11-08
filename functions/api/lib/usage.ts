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
import { chargeBalance, getBalanceMicro, refundBalance } from './balance';

export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

export async function loadSubscription(env: Env, userId: string, now = nowSeconds()): Promise<Subscription> {
  await refreshPlanSpecs(env); // limits come from the plans table (admin → Plans)
  const row = await env.DB
    .prepare('SELECT plan, api_addon, status, current_period_end, overage_enabled, overage_cap_micro_usd FROM subscriptions WHERE user_id = ?1')
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

/** [from, to) in unix seconds for a period key: 'YYYY-MM' (UTC month) or 'lifetime'. */
export function periodRange(period: string, now: number): { from: number; to: number } {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (!m) return { from: 0, to: now + 1 };
  const y = Number(m[1]), mo = Number(m[2]) - 1;
  return { from: Math.floor(Date.UTC(y, mo, 1) / 1000), to: Math.floor(Date.UTC(y, mo + 1, 1) / 1000) };
}

/**
 * Paid AI credits (the "extra" source) of one period: how many and what they cost, in micro-USD. `usage_counters.overage_micro_usd`
 * adds extra posts and extra AI credits into ONE number, so the AI share is read from the usage log instead of being guessed.
 * A missing table or a failing query means "none", never an error for the page.
 */
export async function loadAiExtra(env: Env, userId: string, period: string, now: number): Promise<{ uses: number; micro: number }> {
  try {
    const { from, to } = periodRange(period, now);
    const row = await env.DB
      .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(cost_micro_usd), 0) AS micro FROM usage_logs WHERE user_id = ?1 AND kind = 'ai_post' AND overage = 1 AND created_at >= ?2 AND created_at < ?3`)
      .bind(userId, from, to)
      .first<{ n: number; micro: number }>();
    return { uses: row?.n ?? 0, micro: row?.micro ?? 0 };
  } catch {
    return { uses: 0, micro: 0 };
  }
}

/** Price of one extra AI credit for this account, in micro-USD: the cheaper of the plan's rate and the AI Pass rate; null = nothing to pay for. */
export function aiExtraRate(spec: PlanSpec, passActive: boolean): number | null {
  const rates = [spec.overage && spec.overage.aiPost > 0 ? spec.overage.aiPost : null, passActive ? aiPassOffer().overageMicro : null].filter((r): r is number => r !== null);
  return rates.length ? Math.min(...rates) : null;
}

/** AI credits as the dashboard shows them. See aiMode() for how a plan's `aiCredits` is read. */
function aiBucket(spec: PlanSpec, sub: Subscription, used: number, bonus: number, pass: AiPassState, extraNow: { uses: number; micro: number }): UsageSummary['ai'] {
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
    // postUsd: the same switch also bills extra posts over the plan, so the screen must be able to say so before it is switched on
    extra: {
      enabled: sub.overageEnabled, rateUsd: rate !== null ? microToUsd(rate) : null,
      postUsd: spec.overage ? microToUsd(spec.overage.post) : null,
      uses: extraNow.uses, costUsd: microToUsd(extraNow.micro),
      capUsd: microToUsd(sub.overageCapMicro),
    },
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

  const aiExtra = await loadAiExtra(env, userId, period, now);
  const balanceMicro = await getBalanceMicro(env, userId);
  // Free Trial: UI and API posts draw from ONE total.
  const shared = lim.shared !== null ? bucket(lim.shared, c.api_posts + c.ui_posts) : null;
  // What a new dashboard post would draw from (see reservePosts), and whether one more can be made right now
  const postsLeft = shared ? shared.remaining : lim.ui > 0 ? Math.max(lim.ui - c.ui_posts, 0) : Math.max(lim.api - c.api_posts, 0);
  const canPayExtra = rates !== null && balanceMicro >= rates.post;
  return {
    plan: {
      id: sub.plan, label: spec.label, status: sub.status, lapsed: sub.lapsed, apiAddon: sub.apiAddon,
      currentPeriodEnd: sub.currentPeriodEnd,
    },
    period: { key: period, resetsAt: periodResetsAt(sub.plan, now) },
    api: shared ?? bucket(lim.api, c.api_posts),
    ui: shared ?? bucket(lim.ui, c.ui_posts),
    shared,
    ai: aiBucket(spec, sub, c.ai_generations, await loadAiBonus(env, userId), await loadAiPass(env, userId, now), aiExtra),
    apiAccess: apiAllowed(sub),
    balanceUsd: microToUsd(balanceMicro),
    limit: {
      reached: postsLeft <= 0 && !canPayExtra,
      postsLeft,
      resetsAt: periodResetsAt(sub.plan, now),
      offersExtra: spec.overage !== null,
      extraOn: sub.overageEnabled,
      extraPostUsd: spec.overage ? microToUsd(spec.overage.post) : null,
    },
    features: { priorityDispatch: sub.plan !== 'free' && spec.ui > 0, advancedMcpTools: sub.plan !== 'free' && spec.ui > 0 },   // = isDashboardPlan() in paid.ts (not imported: it imports this file)
    overage: {
      enabled: rates !== null,
      capUsd: microToUsd(sub.overageCapMicro),
      spentUsd: microToUsd(c.overage_micro_usd),
      postUsd: spec.overage ? microToUsd(spec.overage.post) : null,
      aiPostUsd: spec.overage ? microToUsd(spec.overage.aiPost) : null,
      posts: c.overage_posts,
      // extra POSTS only: the counter also holds what extra AI credits cost, which is reported on its own below
      costUsd: microToUsd(Math.max(c.overage_micro_usd - aiExtra.micro, 0)),
      aiUses: aiExtra.uses,
      aiCostUsd: microToUsd(aiExtra.micro),
    },
  };
}

// ───────────────────────── the quota gate ─────────────────────────

const usd = (n: number): string => '$' + String(Math.round(n * 1000) / 1000);
const day = (unix: number): string => new Date(unix * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/**
 * The words for a request that was stopped at the quota: what happened, when it resets, and what to do. The same text goes into the
 * 402 of the API, the dashboard and Studio. `unit` = what ran out ("posts", "AI credits"), `priceUsd` = the price of one extra
 * (null: this plan has none, so only a plan change helps).
 */
export function stopMessage(o: { label: string; unit: string; one: string; reason: StopReason; resetsAt: number | null; priceUsd: number | null }): string {
  const when = o.resetsAt ? `It resets on ${day(o.resetsAt)}.` : 'It does not reset.';
  if (o.reason === 'balance') {
    return `Your balance is too low for another extra ${o.one} (${usd(o.priceUsd ?? 0)} each). Add funds to continue.` + (o.resetsAt ? ` Or wait: your quota resets on ${day(o.resetsAt)}.` : '');
  }
  if (o.priceUsd !== null) {
    return `You have reached your ${o.label} quota of ${o.unit}. ${when} To continue now, add funds to your balance and switch on paying for extra use (${usd(o.priceUsd)} each).`;
  }
  return `You have reached your ${o.label} quota of ${o.unit}. ${when} Choose a plan to continue.`;
}

/** The 402 body for a stopped request: the message plus where to go and what is left. */
export async function stopBody(env: Env, userId: string, sub: Subscription, now: number, what: 'posts' | 'ai', reason: StopReason): Promise<Record<string, unknown>> {
  const spec = specOf(sub.plan);
  const resetsAt = periodResetsAt(sub.plan, now);
  const aiRate = what === 'ai' ? aiExtraRate(spec, (await loadAiPass(env, userId, now)).active) : null;
  const price = what === 'posts' ? (spec.overage ? microToUsd(spec.overage.post) : null) : aiRate !== null ? microToUsd(aiRate) : null;
  return {
    ok: false,
    code: 'quota_exceeded',
    error: stopMessage({ label: spec.label, unit: what === 'posts' ? 'posts' : 'AI credits', one: what === 'posts' ? 'post' : 'AI credit', reason, resetsAt, priceUsd: price }),
    resetsAt,
    topUpUrl: '/topup',
    balanceUsd: microToUsd(await getBalanceMicro(env, userId)),
  };
}

/** Why a request over the quota was refused: 'off' = paying for extra use is not switched on (or this plan has no price for it); 'balance' = it is on but the balance is too small. */
export type StopReason = 'off' | 'balance';
type PostColumn = 'api_posts' | 'ui_posts';

/**
 * The monthly ceiling on extra use (subscriptions.overage_cap_micro_usd, $20 until the account sets its own): true while `costMicro`
 * more still fits under it. A plain read, so a request the ceiling would stop never touches the balance. The counter upserts repeat the
 * test in their WHERE, and that one is the atomic one. No counter row yet means nothing is spent.
 */
async function withinCeiling(env: Env, userId: string, period: string, costMicro: number, sub: Subscription): Promise<boolean> {
  const row = await env.DB.prepare('SELECT overage_micro_usd AS spent FROM usage_counters WHERE user_id = ?1 AND period = ?2').bind(userId, period).first<{ spent: number }>();
  return (row?.spent ?? 0) + costMicro <= sub.overageCapMicro;
}

export type Reservation =
  | { ok: true; overage: boolean; costMicro: number; period: string; column: PostColumn }
  | { ok: false; code: 'api_not_in_plan' }
  | { ok: false; code: 'quota_exceeded'; reason: StopReason }
  | { ok: false; code: 'overage_cap_reached' };

/**
 * Takes `units` from the quota, or says why it can't. `where` is who is asking: the API or the dashboard (dashboard posts, Post now,
 * and the "announce a video" post). The limit is hard: past it nothing is created.
 * Within the quota          → counted, free.
 * Over it, paying switched on and the balance covers it → the price is taken from the balance, then counted (overage_posts / overage_micro_usd).
 * Otherwise                 → { ok: false, code: 'quota_exceeded', reason } and the caller answers 402. Nothing is ever owed.
 *
 * Which counter a request fills: Free Trial has ONE total for both (30 posts); Pro and the others keep the dashboard and the API apart;
 * a plan with no dashboard allowance of its own (Developer API) lets dashboard posts come out of its API allowance.
 */
async function reservePosts(env: Env, userId: string, sub: Subscription, now: number, units: number, where: 'api' | 'ui'): Promise<Reservation> {
  const lim = limitsFor(sub);
  const period = periodKey(sub.plan, now);
  // Constants, never user input: they are put into the SQL text.
  let column: PostColumn; let cap: number; let used: string;
  if (lim.shared !== null) { column = where === 'api' ? 'api_posts' : 'ui_posts'; cap = lim.shared; used = '(api_posts + ui_posts)'; }
  else if (where === 'api') { column = 'api_posts'; cap = lim.api; used = 'api_posts'; }
  else if (lim.ui > 0) { column = 'ui_posts'; cap = lim.ui; used = 'ui_posts'; }
  else { column = 'api_posts'; cap = lim.api; used = 'api_posts'; }

  if (cap >= units) {
    // The WHERE on DO UPDATE makes this all-or-nothing: no row change means the quota was already full.
    const res = await env.DB
      .prepare(
        `INSERT INTO usage_counters (user_id, period, ${column}, updated_at) VALUES (?1, ?2, ?5, ?3)
         ON CONFLICT(user_id, period) DO UPDATE SET ${column} = ${column} + ?5, updated_at = ?3
         WHERE ${used} + ?5 <= ?4`,
      )
      .bind(userId, period, now, cap, units)
      .run();
    if ((res.meta?.changes ?? 0) > 0) return { ok: true, overage: false, costMicro: 0, period, column };
  }

  const rates = overageRates(sub);
  if (!rates) return { ok: false, code: 'quota_exceeded', reason: 'off' };

  const costMicro = Math.round(rates.post * units);
  // The month's ceiling first (a read, so a request it stops never touches the balance), then the money in one statement that cannot
  // overspend, then the counters. If they fail the money goes back.
  if (!(await withinCeiling(env, userId, period, costMicro, sub))) return { ok: false, code: 'overage_cap_reached' };
  if (!(await chargeBalance(env, userId, costMicro, 'post', now))) return { ok: false, code: 'quota_exceeded', reason: 'balance' };
  try {
    // The WHERE is the atomic ceiling: two parallel requests cannot both slip under it.
    const res = await env.DB
      .prepare(
        `INSERT INTO usage_counters (user_id, period, ${column}, overage_posts, overage_micro_usd, updated_at) VALUES (?1, ?2, ?5, ?5, ?4, ?3)
         ON CONFLICT(user_id, period) DO UPDATE SET
           ${column} = ${column} + ?5, overage_posts = overage_posts + ?5, overage_micro_usd = overage_micro_usd + ?4, updated_at = ?3
         WHERE overage_micro_usd + ?4 <= ?6`,
      )
      .bind(userId, period, now, costMicro, units, sub.overageCapMicro)
      .run();
    if ((res.meta?.changes ?? 0) === 0) {
      await refundBalance(env, userId, costMicro, 'post', now).catch(() => undefined);
      return { ok: false, code: 'overage_cap_reached' };
    }
  } catch (err) {
    await refundBalance(env, userId, costMicro, 'post', now).catch(() => undefined);
    throw err;
  }
  return { ok: true, overage: true, costMicro, period, column };
}

/** The API's gate (POST /api/v1/posts). */
export async function reserveApiPost(env: Env, userId: string, sub: Subscription, now: number, units: number): Promise<Reservation> {
  if (!apiAllowed(sub)) return { ok: false, code: 'api_not_in_plan' };
  return reservePosts(env, userId, sub, now, units, 'api');
}

/** The dashboard's gate: creating a post (also "Post now") and announcing a video. Same rules, same counters. */
export async function reserveUiPost(env: Env, userId: string, sub: Subscription, now: number, units: number): Promise<Reservation> {
  return reservePosts(env, userId, sub, now, units, 'ui');
}

/** Gives a reservation back (the post could not be saved after all): the counter, and the money if it was paid for. */
export async function releaseApiPost(env: Env, userId: string, r: Extract<Reservation, { ok: true }>, units: number): Promise<void> {
  const now = nowSeconds();
  try {
    // r.column is one of two constants (see reservePosts)
    await env.DB
      .prepare(
        `UPDATE usage_counters SET
           ${r.column} = MAX(${r.column} - ?3, 0),
           overage_posts = MAX(overage_posts - ?4, 0),
           overage_micro_usd = MAX(overage_micro_usd - ?5, 0),
           updated_at = ?6
         WHERE user_id = ?1 AND period = ?2`,
      )
      .bind(userId, r.period, units, r.overage ? units : 0, r.costMicro, now)
      .run();
  } catch (err) {
    // Not fatal: the counter is at worst one unit too high, and the failure is visible in the logs.
    console.error('quota release failed', err instanceof Error ? err.message : 'unknown');
  }
  if (r.overage && r.costMicro > 0) {
    await refundBalance(env, userId, r.costMicro, 'post', now).catch((err: unknown) => console.error('balance refund failed', err instanceof Error ? err.message : 'unknown'));
  }
}

/** One audit row per metered API call. Meant to be batched together with the rows it describes. */
export function usageLogStatement(
  env: Env,
  e: { userId: string; keyId: string | null; units: number; overage: boolean; costMicro: number; ref: string | null; now: number; source?: 'api' | 'ui' },
): D1PreparedStatement {
  return env.DB
    .prepare(
      `INSERT INTO usage_logs (user_id, api_key_id, source, kind, units, overage, cost_micro_usd, ref, created_at)
       VALUES (?1, ?2, ?8, 'post', ?3, ?4, ?5, ?6, ?7)`,
    )
    .bind(e.userId, e.keyId, e.units, e.overage ? 1 : 0, e.costMicro, e.ref, e.now, e.source ?? 'api');
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
  | { ok: false; code: 'ai_not_in_plan' }
  | { ok: false; code: 'ai_quota_exceeded'; reason: StopReason }
  | { ok: false; code: 'overage_cap_reached' };

/**
 * Takes one AI generation, or says why it can't. Same single-statement guard as reserveApiPost. Where a credit comes from, in this order:
 *   1. the plan's own credits (Free Trial 10 for life, Pro 30 a month)
 *   2. the AI Pass (monthly credits on top of any plan)
 *   3. credits an admin gave to the account
 *   4. an extra credit, paid per generation from the prepaid balance: only when the account switched "pay for extra" on, the plan or the
 *      pass has a price, and the balance covers it
 * Otherwise it is refused (and nothing is owed). A plan with no credit limit at all ('unlimited') is counted and never stopped.
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
    return hadCredits ? { ok: false, code: 'ai_quota_exceeded', reason: 'off' } : { ok: false, code: 'ai_not_in_plan' };
  }
  // The month's ceiling first (a read), then the money (one statement that cannot overspend), then the counters; if they fail the money goes back.
  if (!(await withinCeiling(env, userId, period, rate, sub))) return { ok: false, code: 'overage_cap_reached' };
  if (!(await chargeBalance(env, userId, rate, 'ai', now))) return { ok: false, code: 'ai_quota_exceeded', reason: 'balance' };
  try {
    const res = await env.DB
      .prepare(
        `INSERT INTO usage_counters (user_id, period, ai_generations, overage_micro_usd, updated_at) VALUES (?1, ?2, 1, ?4, ?3)
         ON CONFLICT(user_id, period) DO UPDATE SET ai_generations = ai_generations + 1, overage_micro_usd = overage_micro_usd + ?4, updated_at = ?3
         WHERE overage_micro_usd + ?4 <= ?5`,
      )
      .bind(userId, period, now, rate, sub.overageCapMicro)
      .run();
    if ((res.meta?.changes ?? 0) === 0) {
      await refundBalance(env, userId, rate, 'ai', now).catch(() => undefined);
      return { ok: false, code: 'overage_cap_reached' };
    }
  } catch (err) {
    await refundBalance(env, userId, rate, 'ai', now).catch(() => undefined);
    throw err;
  }
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
  if (r.source === 'extra' && r.costMicro > 0) {
    await refundBalance(env, userId, r.costMicro, 'ai', nowSeconds()).catch((err: unknown) => console.error('balance refund failed', err instanceof Error ? err.message : 'unknown'));
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
