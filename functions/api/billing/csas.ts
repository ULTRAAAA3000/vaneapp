/**
 * GET /api/billing/csas   where the GP webpay gateway (Česká spořitelna) sends the buyer back after the payment page.
 * The query carries the whole result, signed by the bank: DIGEST and DIGEST1 are checked before anything in it is trusted,
 * then the order is settled if PRCODE is 0, and the buyer goes on to the checkout page, which shows the result.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { verifyReturn } from '../lib/csas';
import { fulfillOrder, ORDER_COLUMNS, type OrderRow } from '../lib/billing';
import { methodNotAllowed } from '../lib/http';

async function handle(env: Env, params: URLSearchParams): Promise<Response> {
  const result = await verifyReturn(env, params).catch((err) => { console.error('csas return check failed', err instanceof Error ? err.message : 'unknown'); return null; });
  let to = '/checkout';
  if (result) {
    const order = await env.DB.prepare(`SELECT ${ORDER_COLUMNS} FROM orders WHERE provider = 'csas' AND provider_ref = ?1`).bind(result.orderNumber).first<OrderRow>();
    if (order) {
      to = `/checkout?order=${order.id}`;
      if (result.paid) await fulfillOrder(env, order.id, result.orderNumber, null).catch((err) => console.error('csas fulfill failed', err instanceof Error ? err.message : 'unknown'));
      else if (order.status === 'pending' || order.status === 'expired') await env.DB.prepare(`UPDATE orders SET status = 'failed' WHERE id = ?1 AND status IN ('pending', 'expired')`).bind(order.id).run();
    }
  }
  return new Response(null, { status: 303, headers: { Location: to, 'Cache-Control': 'no-store' } });
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => handle(env, new URL(request.url).searchParams);

/** GP webpay may answer with a POST auto-form instead of a GET redirect when the result is large. */
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const params = new URLSearchParams(await request.text().catch(() => ''));
  return handle(env, params);
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET, POST');
