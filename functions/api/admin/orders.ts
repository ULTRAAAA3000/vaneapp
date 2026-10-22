/**
 * GET  /api/admin/orders?status=pending&q=email   → latest orders (with the buyer's e-mail), 100 at most
 * POST /api/admin/orders  { action: 'confirm' | 'cancel' | 'check', orderId, note? }
 *      confirm  you saw the money yourself (Monobank cabinet, wallet): marks it paid and switches the plan on
 *      cancel   closes a waiting order      check  asks the payment system about it right now
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { audit, requireAdmin } from '../lib/admin';
import { fail, isRecord, json, methodNotAllowed, readJson, UUID_RE } from '../lib/http';
import { fulfillOrder, ORDER_COLUMNS, type OrderRow } from '../lib/billing';
import { checkCryptoOrders, checkMonobankOrder } from '../lib/billingcheck';

const STATUSES = new Set(['pending', 'paid', 'expired', 'failed', 'canceled']);

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;
  const url = new URL(request.url);
  const status = url.searchParams.get('status') ?? '';
  const q = (url.searchParams.get('q') ?? '').trim().toLowerCase().slice(0, 100);
  const where: string[] = [];
  const binds: unknown[] = [];
  if (STATUSES.has(status)) { binds.push(status); where.push(`o.status = ?${binds.length}`); }
  if (q) { binds.push(`%${q.replace(/[%_]/g, '')}%`); where.push(`(LOWER(u.email) LIKE ?${binds.length} OR o.id LIKE ?${binds.length})`); }
  const cols = ORDER_COLUMNS.split(', ').map((c) => `o.${c}`).join(', ');
  const { results } = await env.DB
    .prepare(`SELECT ${cols}, u.email AS user_email FROM orders o JOIN users u ON u.id = o.user_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY o.created_at DESC LIMIT 100`)
    .bind(...binds)
    .all<OrderRow & { user_email: string }>();
  const sums = await env.DB.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS cents FROM orders WHERE status = 'paid'`).first<{ n: number; cents: number }>();
  return json({
    ok: true,
    paid: { count: sums?.n ?? 0, cents: sums?.cents ?? 0 },
    orders: results.map((o) => ({
      id: o.id, email: o.user_email, planId: o.plan_id, planName: o.plan_name, interval: o.interval, amountCents: o.amount_cents, method: o.provider,
      status: o.status, txRef: o.tx_ref, invoiceId: o.provider === 'monobank' ? o.provider_ref : null, payMicro: o.pay_micro, note: o.note,
      billing: (() => { try { return JSON.parse(o.billing); } catch { return {}; } })(), createdAt: o.created_at, paidAt: o.paid_at,
    })),
  });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;
  const parsed = await readJson(request, 2048);
  if (!parsed.ok) return parsed.response;
  const b = parsed.data;
  if (!isRecord(b) || typeof b.orderId !== 'string' || !UUID_RE.test(b.orderId)) return fail(400, 'orderId is invalid.');
  const order = await env.DB.prepare(`SELECT ${ORDER_COLUMNS} FROM orders WHERE id = ?1`).bind(b.orderId).first<OrderRow>();
  if (!order) return fail(404, 'Order not found.');
  const note = typeof b.note === 'string' ? b.note.trim().slice(0, 200) : null;

  if (b.action === 'confirm') {
    if (order.status === 'paid') return fail(409, 'This order is already paid.');
    if (order.status === 'canceled') return fail(409, 'This order was canceled.');
    try {
      await fulfillOrder(env, order.id, null, note || 'confirmed by an admin');
    } catch (err) {
      console.error('admin confirm failed', err instanceof Error ? err.message : 'unknown');
      return fail(500, 'The order was not switched on. Check the plan exists and the database has the latest schema.sql, then try again.');
    }
    await audit(env, request, 'order.confirm', order.id, { plan: order.plan_id, amountCents: order.amount_cents, note });
    return json({ ok: true });
  }
  if (b.action === 'cancel') {
    if (order.status !== 'pending' && order.status !== 'expired') return fail(409, 'Only a waiting order can be canceled.');
    await env.DB.prepare(`UPDATE orders SET status = 'canceled', note = COALESCE(?2, note) WHERE id = ?1`).bind(order.id, note).run();
    await audit(env, request, 'order.cancel', order.id, { note });
    return json({ ok: true });
  }
  if (b.action === 'check') {
    if (order.provider === 'crypto') await checkCryptoOrders(env, order.id);
    else await checkMonobankOrder(env, order);
    const after = await env.DB.prepare('SELECT status FROM orders WHERE id = ?1').bind(order.id).first<{ status: string }>();
    return json({ ok: true, status: after?.status ?? order.status });
  }
  return fail(400, 'Unknown action.');
};
export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET, POST');
