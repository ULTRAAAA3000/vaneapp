/**
 * POST /api/billing/paypal   PayPal calls this for subscription events (set once in the PayPal developer dashboard).
 * The call is verified with PayPal itself (verify-webhook-signature); an unverified call changes nothing.
 * A completed payment settles the order (first payment) or makes a renewal order; the rest only leaves a note for the admin.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { fail, json, methodNotAllowed } from '../lib/http';
import { settlePaypalPayment, checkPaypalSubscription } from '../lib/billingcheck';
import { paypalEnabled, toCents, verifyWebhook } from '../lib/paypal';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

async function noteLatest(env: Env, subscriptionId: string, note: string): Promise<void> {
  await env.DB
    .prepare(`UPDATE orders SET note = ?2 WHERE id = (SELECT id FROM orders WHERE provider = 'paypal' AND provider_ref = ?1 ORDER BY created_at DESC LIMIT 1)`)
    .bind(subscriptionId, note)
    .run();
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!paypalEnabled(env)) return fail(404, 'Not found');
  const raw = await request.text();
  if (raw.length > 100_000) return fail(413, 'Too large');
  if (!(await verifyWebhook(env, request.headers, raw))) return fail(401, 'Bad signature');

  let event: { event_type?: unknown; resource?: Record<string, unknown> };
  try { event = JSON.parse(raw); } catch { return fail(400, 'Invalid JSON'); }
  const type = str(event.event_type);
  const r = event.resource ?? {};

  try {
    if (type === 'PAYMENT.SALE.COMPLETED') {
      const amount = (r.amount ?? {}) as { total?: unknown; currency?: unknown };
      const cents = toCents(amount.total);
      if (str(r.billing_agreement_id) && str(r.id) && cents !== null) {
        await settlePaypalPayment(env, str(r.billing_agreement_id), { id: str(r.id), cents, currency: str(amount.currency) });
      }
    } else if (type === 'BILLING.SUBSCRIPTION.ACTIVATED') {
      if (str(r.id)) await checkPaypalSubscription(env, str(r.id), Math.floor(Date.now() / 1000) - 86400);
    } else if (type === 'BILLING.SUBSCRIPTION.CANCELLED' || type === 'BILLING.SUBSCRIPTION.EXPIRED') {
      if (str(r.id)) await noteLatest(env, str(r.id), 'PayPal subscription ended: no further renewals. Access lasts until the paid period ends.');
    } else if (type === 'BILLING.SUBSCRIPTION.SUSPENDED' || type === 'BILLING.SUBSCRIPTION.PAYMENT.FAILED') {
      if (str(r.id)) await noteLatest(env, str(r.id), 'A PayPal renewal payment failed or the subscription is suspended. Access lasts until the paid period ends.');
    } else if (type === 'PAYMENT.SALE.REFUNDED' || type === 'PAYMENT.SALE.REVERSED') {
      const sale = str(r.sale_id) || str(r.parent_payment);
      if (sale) await env.DB.prepare(`UPDATE orders SET note = 'PayPal refunded or reversed this payment. End the plan in /admin if the money was returned.' WHERE tx_ref = ?1`).bind(sale).run();
    }
  } catch (err) {
    console.error('paypal webhook failed', err instanceof Error ? err.message : 'unknown');
    return fail(500, 'Could not settle the event. Retry later.');
  }
  return json({ ok: true });
};
export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('POST');
