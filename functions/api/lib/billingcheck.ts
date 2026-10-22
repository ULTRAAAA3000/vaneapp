/**
 * "Has this order been paid?" asked of the payment systems themselves: the Monobank invoice, or the Solana chain.
 * Used by the checkout page while it waits, by the cron (buyers who closed the page), and by the admin's "Check now".
 */
import type { Env } from '../../../types';
import { fulfillOrder, LATE_PAYMENT_SECONDS, ORDER_COLUMNS, type OrderRow } from './billing';
import { getInvoiceStatus, monobankCcy, monobankEnabled } from './monobank';
import { findCryptoPayments } from './solana';

type CheckEnv = Pick<Env, 'DB' | 'MONOBANK_TOKEN' | 'MONOBANK_CCY' | 'CRYPTO_WALLET' | 'SOLANA_RPC_URL'>;

/** Settles an order from a Monobank invoice status (the webhook and the poll share this). */
export async function settleMonobank(env: Env, order: OrderRow, status: { status: string; amount?: number; ccy?: number }): Promise<void> {
  if (status.status === 'success') {
    if (status.amount !== order.amount_cents || (status.ccy !== undefined && status.ccy !== monobankCcy(env))) {
      console.error('monobank amount mismatch', order.id);
      await env.DB.prepare(`UPDATE orders SET note = 'The paid amount does not match the order.' WHERE id = ?1 AND status = 'pending'`).bind(order.id).run();
      return;
    }
    await fulfillOrder(env, order.id, null, null);
  } else if (status.status === 'failure' || status.status === 'reversed') {
    await env.DB.prepare(`UPDATE orders SET status = 'failed' WHERE id = ?1 AND status = 'pending'`).bind(order.id).run();
  }
}

/** Asks Monobank about one pending card order. */
export async function checkMonobankOrder(env: Env, order: OrderRow): Promise<void> {
  if (order.provider !== 'monobank' || !order.provider_ref || order.status !== 'pending' || !monobankEnabled(env)) return;
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
  if (!monobankEnabled(env)) return;
  const { results } = await env.DB
    .prepare(`SELECT ${ORDER_COLUMNS} FROM orders WHERE provider = 'monobank' AND status = 'pending' AND created_at <= ?1 ORDER BY created_at LIMIT 20`)
    .bind(now - 120)
    .all<OrderRow>();
  for (const o of results) await checkMonobankOrder(env, o).catch(() => undefined);
}
