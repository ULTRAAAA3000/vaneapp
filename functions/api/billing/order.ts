/**
 * GET /api/billing/order?id=<orderId>  → { ok, order }   one of your orders; while it is waiting the payment system is asked about it
 * GET /api/billing/order               → { ok, orders }  your latest orders
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { requireUser } from '../lib/auth';
import { fail, json, methodNotAllowed, UUID_RE } from '../lib/http';
import { ORDER_COLUMNS, orderView, type OrderRow } from '../lib/billing';
import { checkCryptoOrders, checkMonobankOrder } from '../lib/billingcheck';
import { assetOfMint, cryptoWallet, formatMicro, SOLANA_ASSETS, solanaPayUrl } from '../lib/solana';
import { bump, retryAfter } from '../lib/throttle';

export function cryptoDetails(env: Pick<Env, 'CRYPTO_WALLET'>, o: OrderRow): Record<string, unknown> | null {
  const wallet = cryptoWallet(env);
  if (o.provider !== 'crypto' || !o.provider_ref || !o.pay_micro || !wallet) return null;
  const asset = assetOfMint(o.provider_ref);
  return { address: wallet, asset: asset, assetLabel: asset ? SOLANA_ASSETS[asset].label : '', mint: o.provider_ref, amount: formatMicro(o.pay_micro), network: 'Solana', solanaPayUrl: solanaPayUrl(wallet, o.provider_ref, o.pay_micro, 'Vane') };
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  const id = new URL(request.url).searchParams.get('id');

  if (!id) {
    const { results } = await env.DB.prepare(`SELECT ${ORDER_COLUMNS} FROM orders WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 10`).bind(auth.userId).all<OrderRow>();
    return json({ ok: true, orders: results.map(orderView) });
  }
  if (!UUID_RE.test(id)) return fail(400, 'Invalid order id.');
  let order = await env.DB.prepare(`SELECT ${ORDER_COLUMNS} FROM orders WHERE id = ?1 AND user_id = ?2`).bind(id, auth.userId).first<OrderRow>();
  if (!order) return fail(404, 'Order not found.');
  const now = Math.floor(Date.now() / 1000);

  if (order.status === 'pending' || (order.status === 'expired' && order.provider === 'crypto')) {
    const key = `order-check:${id}`;
    if (!(await retryAfter(env, key, 1))) {
      await bump(env, key, 4);
      try {
        if (order.provider === 'crypto') await checkCryptoOrders(env, id);
        else if (now - order.created_at > 10) await checkMonobankOrder(env, order);
      } catch (err) {
        console.error('order check failed', err instanceof Error ? err.message : 'unknown');
      }
    }
    if (order.status === 'pending' && order.expires_at <= now) await env.DB.prepare(`UPDATE orders SET status = 'expired' WHERE id = ?1 AND status = 'pending'`).bind(id).run();
    order = (await env.DB.prepare(`SELECT ${ORDER_COLUMNS} FROM orders WHERE id = ?1`).bind(id).first<OrderRow>()) ?? order;
  }
  const open = order.status === 'pending' || (order.status === 'expired' && order.provider === 'crypto');
  return json({ ok: true, order: { ...orderView(order), payUrl: order.provider === 'monobank' && open ? order.pay_url : null, crypto: open ? cryptoDetails(env, order) : null } });
};
export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET');
