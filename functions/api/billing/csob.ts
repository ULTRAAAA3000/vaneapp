/**
 * GET /api/billing/csob   where the ČSOB gateway sends the buyer back (returnUrl) after the payment page.
 * The query is not trusted: it only names the payment; the bank is asked for its status (signed both ways), the order is settled
 * if it was paid, and the buyer goes on to the checkout page, which shows the result.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { checkCsobOrder } from '../lib/billingcheck';
import { ORDER_COLUMNS, type OrderRow } from '../lib/billing';
import { methodNotAllowed } from '../lib/http';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url);
  const payId = (url.searchParams.get('payId') ?? '').slice(0, 40);
  let to = '/checkout';
  if (/^[A-Za-z0-9]+$/.test(payId)) {
    const order = await env.DB.prepare(`SELECT ${ORDER_COLUMNS} FROM orders WHERE provider = 'csob' AND provider_ref = ?1`).bind(payId).first<OrderRow>();
    if (order) {
      await checkCsobOrder(env, order).catch((err) => console.error('csob return check failed', err instanceof Error ? err.message : 'unknown'));
      to = `/checkout?order=${order.id}`;
    }
  }
  return new Response(null, { status: 303, headers: { Location: to, 'Cache-Control': 'no-store' } });
};
export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET');
