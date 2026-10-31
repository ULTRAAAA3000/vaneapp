/**
 * Checkout and payments: what a plan costs for an interval, the order, and switching the plan on once the money is in.
 * A payment can be seen by several things at once (the Monobank webhook, the checkout page asking, the cron, an admin), so
 * `fulfillOrder` claims the order with one conditional UPDATE and only the caller that wins activates the plan.
 */
import type { Env } from '../../../types';
import { getPlan, type Plan } from './catalog';
import { requireAdmin } from './admin';
import { emailConfigured, sendMail } from './mail';
import { getSettings } from './settings';
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

/** The admin's "Checkout preview" switch, and only for a browser signed into /admin: it shows the checkout without selling anything. */
export async function previewActive(env: Env, request: Request): Promise<boolean> {
  if (!(await getSettings(env)).checkout_preview) return false;
  return (await requireAdmin(request, env)).ok;
}

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

async function grantAnalytics(env: Env, o: OrderRow, now: number): Promise<void> {
  const row = await env.DB.prepare('SELECT status, current_period_end FROM analytics_subscriptions WHERE user_id = ?1').bind(o.user_id).first<Row>();
  const end = addInterval(startOf(row, now, true), o.interval);
  await env.DB
    .prepare(
      `INSERT INTO analytics_subscriptions (user_id, status, current_period_end, provider, created_at, updated_at) VALUES (?1, 'active', ?2, ?3, ?4, ?4)
       ON CONFLICT(user_id) DO UPDATE SET status = 'active', current_period_end = excluded.current_period_end, provider = excluded.provider, updated_at = excluded.updated_at`,
    )
    .bind(o.user_id, end, o.provider, now)
    .run();
}

/** What a paid order switches on. 'video' = Vane Studio, 'ai-pass' = AI Pass, 'api-addon' = Pro's API add-on, 'suite' = Pro + Studio + Analytics Pro + AI Pass (its API posts come from the plan's own limits), anything else = that plan. */
export async function activate(env: Env, o: OrderRow, now: number): Promise<void> {
  if (o.plan_id === 'video') return grantVideo(env, o, now);
  if (o.plan_id === 'ai-pass') return grantAiPass(env, o, now);
  if (o.plan_id === 'analytics') return grantAnalytics(env, o, now);
  if (o.plan_id === 'api-addon') {
    await env.DB.prepare(`UPDATE subscriptions SET api_addon = 1, updated_at = ?2 WHERE user_id = ?1`).bind(o.user_id, now).run();
    return;
  }
  await grantPost(env, o, o.plan_id === 'suite' ? 'suite' : o.plan_id, now);
  if (o.plan_id === 'suite') {
    await grantVideo(env, o, now);
    await grantAnalytics(env, o, now);
    await grantAiPass(env, o, now);
  }
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
    .prepare(`UPDATE orders SET status = 'paid', paid_at = ?2, tx_ref = COALESCE(?3, tx_ref), note = COALESCE(?4, note) WHERE id = ?1 AND (status IN ('pending', 'expired') OR (status = 'failed' AND provider = 'monobank'))`)
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
  await sendReceipt(env, order, now).catch(() => undefined);
  return 'paid';
}

const escHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

/** When access really ends after this order (a renewal starts from the old end, so it is not simply now + one period). */
async function periodEnd(env: Env, o: OrderRow, now: number): Promise<number> {
  const table = o.plan_id === 'video' ? 'video_subscriptions' : o.plan_id === 'ai-pass' ? 'ai_pass' : o.plan_id === 'analytics' ? 'analytics_subscriptions' : 'subscriptions';
  try {
    const row = await env.DB.prepare(`SELECT current_period_end FROM ${table} WHERE user_id = ?1`).bind(o.user_id).first<{ current_period_end: number | null }>();
    if (row?.current_period_end) return row.current_period_end;
  } catch { /* fall back below */ }
  return addInterval(now, o.interval);
}

/** The receipt e-mail (only when Resend is set up). Never blocks or fails an activation. */
export async function sendReceipt(env: Env, o: OrderRow, now: number): Promise<void> {
  if (!emailConfigured(env)) return;
  let to = '';
  let name = '';
  try { const b = JSON.parse(o.billing) as { email?: string; name?: string }; to = b.email ?? ''; name = b.name ?? ''; } catch { return; }
  if (!to) return;
  const amount = `${(o.amount_cents / 100).toFixed(2)} ${o.currency}`;
  const until = new Date((await periodEnd(env, o, now)) * 1000).toISOString().slice(0, 10);
  const how = o.provider === 'crypto' ? 'Crypto (Solana)' : 'Card';
  const lines = [`Plan: ${o.plan_name} (${o.interval === 'year' ? '1 year' : '1 month'})`, `Amount: ${amount}`, `Paid with: ${how}`, `Active until about: ${until}`, `Order: ${o.id}`];
  await sendMail(env, {
    to,
    optional: true,
    subject: `Your Vane receipt: ${o.plan_name}`,
    text: `${name ? `Hi ${name},\n\n` : ''}Thank you, your payment was received and ${o.plan_name} is active.\n\n${lines.join('\n')}\n\nThe plan is not renewed automatically: pay again from vaneapp.dev/pricing when the period ends.\n`,
    html: `<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#111"><h2 style="margin:0 0 12px">Payment received</h2><p style="margin:0 0 16px">${name ? `Hi ${escHtml(name)}, t` : 'T'}hank you. <b>${escHtml(o.plan_name)}</b> is active on your account.</p><table style="width:100%;border-collapse:collapse;font-size:14px">${lines.map((l) => { const i = l.indexOf(':'); return `<tr><td style="padding:6px 0;color:#666">${escHtml(l.slice(0, i))}</td><td style="padding:6px 0;text-align:right">${escHtml(l.slice(i + 1).trim())}</td></tr>`; }).join('')}</table><p style="margin:20px 0 0;font-size:12px;color:#777">The plan is not renewed automatically. Pay again from vaneapp.dev/pricing when the period ends.</p></div>`,
  });
}

export const orderView = (o: OrderRow): Record<string, unknown> => ({
  id: o.id, planId: o.plan_id, planName: o.plan_name, interval: o.interval, amountCents: o.amount_cents, currency: o.currency,
  method: o.provider, status: o.status, createdAt: o.created_at, expiresAt: o.expires_at, paidAt: o.paid_at,
});

export { getPlan };
