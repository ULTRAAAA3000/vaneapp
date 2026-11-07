/**
 * "Has this order been paid?" asked of the payment systems themselves: the Monobank invoice, or the Solana chain.
 * Used by the checkout page while it waits, by the cron (buyers who closed the page), and by the admin's "Check now".
 */
import type { Env } from '../../../types';
import { fulfillOrder, LATE_PAYMENT_SECONDS, ORDER_COLUMNS, PAY_WINDOW_SECONDS, type OrderRow } from './billing';
import { getInvoiceStatus, monobankCcy, monobankEnabled } from './monobank';
import { findCryptoPayments } from './solana';
import { FAILED_STATUSES, PAID_STATUSES, REVERSED_STATUSES, csobEnabled, paymentStatus } from './csob';
import { completedPayments, paypalEnabled, type PaypalPayment } from './paypal';

type CheckEnv = Pick<Env, 'DB' | 'MONOBANK_TOKEN' | 'CRYPTO_WALLET' | 'SOLANA_RPC_URL' | 'PAYPAL_CLIENT_ID' | 'PAYPAL_CLIENT_SECRET' | 'PAYPAL_ENV' | 'PAYPAL_WEBHOOK_ID' | 'CSOB_MERCHANT_ID' | 'CSOB_PRIVATE_KEY' | 'CSOB_BANK_PUBLIC_KEY' | 'CSOB_ENV'>;

/** Settles an order from a Monobank invoice status (the webhook and the poll share this). */
export async function settleMonobank(env: Env, order: OrderRow, status: { status: string; amount?: number; ccy?: number }): Promise<void> {
  if (status.status === 'success') {
    if (status.amount !== order.amount_cents || (status.ccy !== undefined && status.ccy !== monobankCcy(order.currency))) {
      console.error('monobank amount mismatch', order.id);
      await env.DB.prepare(`UPDATE orders SET note = 'The paid amount does not match the order.' WHERE id = ?1 AND status IN ('pending', 'failed')`).bind(order.id).run();
      return;
    }
    await fulfillOrder(env, order.id, null, null);
  } else if (status.status === 'reversed' && order.status === 'paid') {
    console.error('monobank payment reversed after it was paid', order.id);
    await env.DB.prepare(`UPDATE orders SET note = 'Monobank reversed this payment (refund or chargeback). End the plan in /admin if the money was returned.' WHERE id = ?1 AND status = 'paid'`).bind(order.id).run();
  } else if (status.status === 'failure' || status.status === 'reversed') {
    await env.DB.prepare(`UPDATE orders SET status = 'failed' WHERE id = ?1 AND status = 'pending'`).bind(order.id).run();
  }
}

/**
 * One completed payment of a PayPal subscription (the webhook and the poll share this). The first payment settles the order the
 * buyer made at checkout; every later one is a renewal and becomes an order of its own, so each period has its receipt and its
 * place in the list. A payment is recognised by its PayPal id (orders.tx_ref is unique), so reports of it can repeat safely.
 */
export async function settlePaypalPayment(env: Env, subscriptionId: string, pay: PaypalPayment): Promise<'paid' | 'already' | 'missing' | 'mismatch'> {
  if (await env.DB.prepare('SELECT 1 FROM orders WHERE tx_ref = ?1').bind(pay.id).first()) return 'already';
  const first = await env.DB
    .prepare(`SELECT ${ORDER_COLUMNS} FROM orders WHERE provider = 'paypal' AND provider_ref = ?1 ORDER BY created_at ASC LIMIT 1`)
    .bind(subscriptionId)
    .first<OrderRow>();
  if (!first) return 'missing';
  if (pay.cents !== first.amount_cents || pay.currency !== first.currency) {
    console.error('paypal amount mismatch', first.id);
    await env.DB.prepare(`UPDATE orders SET note = 'The paid amount does not match the order.' WHERE id = ?1`).bind(first.id).run();
    return 'mismatch';
  }
  if (first.status !== 'paid') return fulfillOrder(env, first.id, pay.id, null);

  const now = Math.floor(Date.now() / 1000);
  const id = crypto.randomUUID();
  try {
    await env.DB
      .prepare(
        `INSERT INTO orders (id, user_id, plan_id, plan_name, interval, amount_cents, currency, provider, provider_ref, tx_ref, status, billing, note, created_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'paypal', ?8, ?9, 'pending', ?10, 'Renewal', ?11, ?12)`,
      )
      .bind(id, first.user_id, first.plan_id, first.plan_name, first.interval, first.amount_cents, first.currency, subscriptionId, pay.id, first.billing, now, now + PAY_WINDOW_SECONDS)
      .run();
  } catch {
    return 'already';
  }
  return fulfillOrder(env, id, pay.id, null);
}

/** Asks PayPal for the payments of one subscription and settles those found. Returns how many were new. */
export async function checkPaypalSubscription(env: Env, subscriptionId: string, sinceSeconds: number): Promise<number> {
  if (!paypalEnabled(env)) return 0;
  let fresh = 0;
  for (const pay of await completedPayments(env, subscriptionId, sinceSeconds)) {
    if ((await settlePaypalPayment(env, subscriptionId, pay)) === 'paid') fresh++;
  }
  return fresh;
}

export async function checkPaypalOrder(env: Env, order: OrderRow): Promise<void> {
  if (order.provider !== 'paypal' || !order.provider_ref || (order.status !== 'pending' && order.status !== 'expired')) return;
  await checkPaypalSubscription(env, order.provider_ref, order.created_at);
}

/** Asks the ČSOB gateway about one card order: paid, refused or cancelled by the buyer, or reversed afterwards. */
export async function checkCsobOrder(env: Env, order: OrderRow): Promise<void> {
  if (order.provider !== 'csob' || !order.provider_ref || (order.status !== 'pending' && order.status !== 'expired') || !csobEnabled(env)) return;
  const st = await paymentStatus(env, order.provider_ref);
  if (!st || st.resultCode !== 0 || st.status === null) return;
  if (PAID_STATUSES.has(st.status)) await fulfillOrder(env, order.id, order.provider_ref, null);
  else if (FAILED_STATUSES.has(st.status)) await env.DB.prepare(`UPDATE orders SET status = 'failed' WHERE id = ?1 AND status IN ('pending', 'expired')`).bind(order.id).run();
}

export async function noteCsobReversals(env: Env): Promise<void> {
  if (!csobEnabled(env)) return;
  const { results } = await env.DB
    .prepare(`SELECT ${ORDER_COLUMNS} FROM orders WHERE provider = 'csob' AND status = 'paid' AND note IS NULL AND paid_at > ?1 ORDER BY paid_at DESC LIMIT 20`)
    .bind(Math.floor(Date.now() / 1000) - 14 * 86400)
    .all<OrderRow>();
  for (const o of results) {
    const st = o.provider_ref ? await paymentStatus(env, o.provider_ref) : null;
    if (st?.status != null && REVERSED_STATUSES.has(st.status)) {
      await env.DB.prepare(`UPDATE orders SET note = 'The bank reversed or refunded this payment. End the plan in /admin if the money was returned.' WHERE id = ?1 AND note IS NULL`).bind(o.id).run();
    }
  }
}

/** Asks Monobank about one pending card order. */
export async function checkMonobankOrder(env: Env, order: OrderRow): Promise<void> {
  if (order.provider !== 'monobank' || !order.provider_ref || (order.status !== 'pending' && order.status !== 'failed') || !monobankEnabled(env)) return;
  const st = await getInvoiceStatus(env, order.provider_ref);
  if (st) await settleMonobank(env, order, st);
}

/** Looks for crypto payments for these orders (all pending ones, or the one given) and settles those found. Returns how many were paid. */
export async function checkCryptoOrders(env: Env & CheckEnv, only?: string): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const { results } = await env.DB
    .prepare(
      `SELECT ${ORDER_COLUMNS} FROM orders WHERE provider = 'crypto' AND provider_ref IS NOT NULL AND pay_micro IS NOT NULL
         AND (status = 'pending' OR (status = 'expired' AND expires_at > ?1)) ${only ? 'AND id = ?2' : ''} ORDER BY created_at LIMIT 30`,
    )
    .bind(...(only ? [now - LATE_PAYMENT_SECONDS, only] : [now - LATE_PAYMENT_SECONDS]))
    .all<OrderRow>();
  if (!results.length) return 0;
  const usedRows = await env.DB.prepare(`SELECT tx_ref FROM orders WHERE tx_ref IS NOT NULL ORDER BY paid_at DESC LIMIT 200`).all<{ tx_ref: string }>();
  const hits = await findCryptoPayments(env, results.map((o) => ({ id: o.id, mint: o.provider_ref as string, payMicro: o.pay_micro as number, createdAt: o.created_at })), new Set(usedRows.results.map((r) => r.tx_ref)));
  let paid = 0;
  for (const [id, sig] of hits) {
    if ((await fulfillOrder(env, id, sig, null)) === 'paid') paid++;
  }
  return paid;
}

/** Cron: mark overdue orders expired, then look for payments and check card orders that never got their webhook. */
export async function sweepOrders(env: Env & CheckEnv, now: number): Promise<void> {
  await env.DB.prepare(`UPDATE orders SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?1`).bind(now).run();
  await checkCryptoOrders(env);
  if (csobEnabled(env)) {
    const waiting = await env.DB
      .prepare(`SELECT ${ORDER_COLUMNS} FROM orders WHERE provider = 'csob' AND status IN ('pending', 'expired') AND created_at <= ?1 AND created_at > ?2 ORDER BY created_at LIMIT 20`)
      .bind(now - 120, now - 2 * 86400)
      .all<OrderRow>();
    for (const o of waiting.results) await checkCsobOrder(env as Env, o).catch(() => undefined);
    if (now % 3600 < 60) await noteCsobReversals(env as Env).catch(() => undefined);
  }
  if (paypalEnabled(env)) {
    const waiting = await env.DB
      .prepare(`SELECT ${ORDER_COLUMNS} FROM orders WHERE provider = 'paypal' AND status IN ('pending', 'expired') AND created_at <= ?1 AND created_at > ?2 ORDER BY created_at LIMIT 20`)
      .bind(now - 120, now - 2 * 86400)
      .all<OrderRow>();
    for (const o of waiting.results) await checkPaypalOrder(env as Env, o).catch(() => undefined);
  }
  if (!monobankEnabled(env)) return;
  const { results } = await env.DB
    .prepare(`SELECT ${ORDER_COLUMNS} FROM orders WHERE provider = 'monobank' AND status IN ('pending', 'failed') AND created_at <= ?1 AND created_at > ?2 ORDER BY created_at LIMIT 20`)
    .bind(now - 120, now - 6 * 3600)
    .all<OrderRow>();
  for (const o of results) await checkMonobankOrder(env, o).catch(() => undefined);
}
