/**
 * POST /api/billing/monobank   Monobank calls this when an invoice changes (set per invoice as webHookUrl).
 * The body is signed (X-Sign); an unsigned or forged call changes nothing. Even a signed call is double-checked with Monobank's invoice status.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { fail, json } from '../lib/http';
import { ORDER_COLUMNS, type OrderRow } from '../lib/billing';
import { settleMonobank } from '../lib/billingcheck';
import { getInvoiceStatus, monobankEnabled, verifyWebhook } from '../lib/monobank';

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!monobankEnabled(env)) return fail(404, 'Not found');
  const raw = await request.text();
  if (raw.length > 20_000) return fail(413, 'Too large');
  if (!(await verifyWebhook(env, raw, request.headers.get('x-sign')))) return fail(401, 'Bad signature');

  let body: { invoiceId?: unknown; status?: unknown; amount?: unknown; ccy?: unknown };
  try { body = JSON.parse(raw); } catch { return fail(400, 'Invalid JSON'); }
  if (typeof body.invoiceId !== 'string' || typeof body.status !== 'string') return json({ ok: true });

  const order = await env.DB.prepare(`SELECT ${ORDER_COLUMNS} FROM orders WHERE provider = 'monobank' AND provider_ref = ?1`).bind(body.invoiceId).first<OrderRow>();
  if (!order) return json({ ok: true });
  const live = await getInvoiceStatus(env, body.invoiceId);
  try {
    await settleMonobank(env, order, live ?? { status: body.status, amount: typeof body.amount === 'number' ? body.amount : undefined, ccy: typeof body.ccy === 'number' ? body.ccy : undefined });
  } catch (err) {
    console.error('monobank settle failed', err instanceof Error ? err.message : 'unknown');
    return fail(500, 'Could not settle the order. Retry later.');   // Monobank retries until it gets a 200
  }
  return json({ ok: true });
};
