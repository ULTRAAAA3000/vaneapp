/**
 * Checkout and payments: what a plan costs for an interval, the order, and switching the plan on once the money is in.
 * A payment can be seen by several things at once (the Monobank webhook, the checkout page asking, the cron, an admin), so
 * `fulfillOrder` claims the order with one conditional UPDATE and only the caller that wins activates the plan.
 */
import type { Env } from '../../../types';
import { getPlan, type Plan } from './catalog';
import { monobankEnabled } from './monobank';
import { cryptoEnabled } from './solana';

export type Interval = 'month' | 'year';
export type Method = 'monobank' | 'crypto';

export const PAY_WINDOW_SECONDS = 3600;
export const LATE_PAYMENT_SECONDS = 24 * 3600;

export const billingMethods = (env: Pick<Env, 'MONOBANK_TOKEN' | 'CRYPTO_WALLET'>): { monobank: boolean; crypto: boolean } =>
  ({ monobank: monobankEnabled(env), crypto: cryptoEnabled(env) });

export const billingEnabled = (env: Pick<Env, 'MONOBANK_TOKEN' | 'CRYPTO_WALLET'>): boolean => {
  const m = billingMethods(env);
  return m.monobank || m.crypto;
};

/** A plan the checkout can sell right now. */
export const isBuyable = (p: Plan): boolean => p.isActive && !p.comingSoon && p.id !== 'free' && p.priceCents > 0;

export function quote(plan: Plan, interval: Interval): { ok: true; amountCents: number; interval: Interval } | { ok: false; error: string } {
  if (!isBuyable(plan)) return { ok: false, error: 'This plan is not on sale yet.' };
  if (plan.interval === 'once') return { ok: false, error: 'This plan cannot be bought online yet.' };
  if (interval === 'year') {
    if (plan.interval === 'year') return { ok: true, amountCents: plan.priceCents, interval: 'year' };
    if (!plan.yearlyPriceCents) return { ok: false, error: 'This plan has no yearly price.' };
    return { ok: true, amountCents: plan.yearlyPriceCents, interval: 'year' };
  }
  if (plan.interval === 'year') return { ok: true, amountCents: plan.priceCents, interval: 'year' };
  return { ok: true, amountCents: plan.priceCents, interval: 'month' };
}

export function addInterval(from: number, interval: Interval): number {
  const d = new Date(from * 1000);
  d.setUTCMonth(d.getUTCMonth() + (interval === 'year' ? 12 : 1));
  return Math.floor(d.getTime() / 1000);
}

export interface OrderRow {
  id: string; user_id: string; plan_id: string; plan_name: string; interval: Interval; amount_cents: number; currency: string;
  provider: Method; provider_ref: string | null; pay_url: string | null; pay_micro: number | null; tx_ref: string | null;
  status: 'pending' | 'paid' | 'expired' | 'failed' | 'canceled'; billing: string; note: string | null; created_at: number; expires_at: number; paid_at: number | null;
}
export const ORDER_COLUMNS = 'id, user_id, plan_id, plan_name, interval, amount_cents, currency, provider, provider_ref, pay_url, pay_micro, tx_ref, status, billing, note, created_at, expires_at, paid_at';

interface Row { status: string; current_period_end: number | null; plan?: string }

/** Where the new period starts: the end of the current one when it is still running (renewal), otherwise now. */
const startOf = (row: Row | null, now: number, samePlan: boolean): number =>
  row && samePlan && row.status === 'active' && row.current_period_end !== null && row.current_period_end > now ? row.current_period_end : now;

async function grantPost(env: Env, o: OrderRow, planId: string, now: number): Promise<void> {
  const row = await env.DB.prepare('SELECT plan, status, current_period_end FROM subscriptions WHERE user_id = ?1').bind(o.user_id).first<Row>();
  const end = addInterval(startOf(row, now, row?.plan === planId), o.interval);
  await env.DB
    .prepare(
      `INSERT INTO subscriptions (user_id, plan, api_addon, status, current_period_end, overage_enabled, provider, provider_ref, created_at, updated_at)
       VALUES (?1, ?2, 0, 'active', ?3, 0, ?4, ?5, ?6, ?6)
       ON CONFLICT(user_id) DO UPDATE SET api_addon = CASE WHEN subscriptions.plan = excluded.plan THEN subscriptions.api_addon ELSE 0 END,
         plan = excluded.plan, status = 'active', current_period_end = excluded.current_period_end,
         provider = excluded.provider, provider_ref = excluded.provider_ref, updated_at = excluded.updated_at`,
    )
    .bind(o.user_id, planId, end, o.provider, o.id, now)
    .run();
}

async function grantVideo(env: Env, o: OrderRow, now: number): Promise<void> {
  const row = await env.DB.prepare('SELECT status, current_period_end FROM video_subscriptions WHERE user_id = ?1').bind(o.user_id).first<Row>();
  const end = addInterval(startOf(row, now, true), o.interval);
  await env.DB
    .prepare(
      `INSERT INTO video_subscriptions (user_id, status, current_period_end, provider, provider_ref, created_at, updated_at) VALUES (?1, 'active', ?2, ?3, ?4, ?5, ?5)
       ON CONFLICT(user_id) DO UPDATE SET status = 'active', current_period_end = excluded.current_period_end, provider = excluded.provider, provider_ref = excluded.provider_ref, updated_at = excluded.updated_at`,
    )
    .bind(o.user_id, end, o.provider, o.id, now)
    .run();
}

async function grantAiPass(env: Env, o: OrderRow, now: number): Promise<void> {
  const row = await env.DB.prepare('SELECT status, current_period_end FROM ai_pass WHERE user_id = ?1').bind(o.user_id).first<Row>();
  const end = addInterval(startOf(row, now, true), o.interval);
  await env.DB
    .prepare(
      `INSERT INTO ai_pass (user_id, status, current_period_end, provider, created_at, updated_at) VALUES (?1, 'active', ?2, ?3, ?4, ?4)
       ON CONFLICT(user_id) DO UPDATE SET status = 'active', current_period_end = excluded.current_period_end, provider = excluded.provider, updated_at = excluded.updated_at`,
    )
    .bind(o.user_id, end, o.provider, now)
    .run();
}

/** What a paid order switches on. 'video' = Vane Studio, 'ai-pass' = AI Pass, 'api-addon' = Pro's API add-on, 'suite' = Pro + Studio, anything else = that plan. */
export async function activate(env: Env, o: OrderRow, now: number): Promise<void> {
  if (o.plan_id === 'video') return grantVideo(env, o, now);
  if (o.plan_id === 'ai-pass') return grantAiPass(env, o, now);
  if (o.plan_id === 'api-addon') {
    await env.DB.prepare(`UPDATE subscriptions SET api_addon = 1, updated_at = ?2 WHERE user_id = ?1`).bind(o.user_id, now).run();
    return;
  }
  await grantPost(env, o, o.plan_id === 'suite' ? 'suite' : o.plan_id, now);
  if (o.plan_id === 'suite') await grantVideo(env, o, now);
}

/** The API add-on only makes sense on top of an active Pro plan. */
export async function addonAllowed(env: Env, userId: string, now: number): Promise<boolean> {
  const row = await env.DB.prepare('SELECT plan, status, current_period_end FROM subscriptions WHERE user_id = ?1').bind(userId).first<Row>();
  return !!row && row.plan === 'pro' && row.status === 'active' && (row.current_period_end === null || row.current_period_end > now);
}

/**
 * Marks the order paid and switches the plan on, exactly once however many things report the payment.
 * Returns 'paid' for the call that did it, 'already' when it was paid before, 'missing' when there is no such order.
 * If switching the plan on fails the order goes back to pending (so the next report retries it) and the error is thrown.
 */
export async function fulfillOrder(env: Env, orderId: string, txRef: string | null = null, note: string | null = null): Promise<'paid' | 'already' | 'missing'> {
  const now = Math.floor(Date.now() / 1000);
  const claim = await env.DB
    .prepare(`UPDATE orders SET status = 'paid', paid_at = ?2, tx_ref = COALESCE(?3, tx_ref), note = COALESCE(?4, note) WHERE id = ?1 AND status IN ('pending', 'expired')`)
    .bind(orderId, now, txRef, note)
    .run();
  const order = await env.DB.prepare(`SELECT ${ORDER_COLUMNS} FROM orders WHERE id = ?1`).bind(orderId).first<OrderRow>();
  if (!order) return 'missing';
  if (!(claim.meta?.changes ?? 0)) return 'already';
  try {
    await activate(env, order, now);
  } catch (err) {
    await env.DB.prepare(`UPDATE orders SET status = 'pending', paid_at = NULL WHERE id = ?1`).bind(orderId).run().catch(() => undefined);
    throw err;
  }
  return 'paid';
}

export const orderView = (o: OrderRow): Record<string, unknown> => ({
  id: o.id, planId: o.plan_id, planName: o.plan_name, interval: o.interval, amountCents: o.amount_cents, currency: o.currency,
  method: o.provider, status: o.status, createdAt: o.created_at, expiresAt: o.expires_at, paidAt: o.paid_at,
});

export { getPlan };
