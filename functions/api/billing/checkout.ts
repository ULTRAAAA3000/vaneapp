/**
 * POST /api/billing/checkout  { planId, interval?: 'month'|'year', method: 'monobank'|'crypto', asset?: 'usdt'|'usdc',
 *                               billing: { name, email, country, company?, vatId? } }
 *   → { ok, order: { id, status, planName, amountCents, … , payUrl? | crypto: { address, asset, mint, amount, solanaPayUrl } } }
 *
 * Creates (or, for the same choices while the old one is still open, reuses) the order. Card: the buyer goes to `payUrl`
 * (Monobank's page). Crypto: the buyer sends the exact `amount` to `address`; the checkout page watches for it.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { requireUser } from '../lib/auth';
import { fail, isRecord, json, methodNotAllowed, readJson, EMAIL_RE } from '../lib/http';
import { addonAllowed, billingEnabled, billingMethods, getPlan, previewActive, ORDER_COLUMNS, orderView, PAY_WINDOW_SECONDS, quote, type Interval, type Method, type OrderRow } from '../lib/billing';
import { createInvoice } from '../lib/monobank';
import { SOLANA_ASSETS, type CryptoAsset } from '../lib/solana';
import { bump, retryAfter } from '../lib/throttle';
import { cryptoDetails } from './order';

const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;
  const parsed = await readJson(request, 4096);
  if (!parsed.ok) return parsed.response;
  const b = parsed.data;
  if (!isRecord(b)) return fail(400, 'Send a JSON object.');

  const method = b.method as Method;
  if (method !== 'monobank' && method !== 'crypto') return fail(400, 'Choose how to pay: card or crypto.');
  if (!billingEnabled(env) && (await previewActive(env, request))) return fail(503, 'Preview only: payment is not connected yet, so nothing can be bought. (The Monobank token or the crypto wallet is missing, or the plan is not switched on.)');
  if (!billingMethods(env)[method]) return fail(503, method === 'monobank' ? 'Card payment is not open yet. You can pay with crypto, or try again later.' : 'Crypto payment is not open yet.');
  const asset = (b.asset === 'usdc' ? 'usdc' : 'usdt') as CryptoAsset;
  const interval: Interval = b.interval === 'year' ? 'year' : 'month';

  const bill = isRecord(b.billing) ? b.billing : {};
  const billing = { name: text(bill.name, 100), email: text(bill.email, 160).toLowerCase(), country: text(bill.country, 20).toUpperCase(), company: text(bill.company, 120), vatId: text(bill.vatId, 40) };
  if (billing.name.length < 2) return fail(400, 'Enter your name.');
  if (!EMAIL_RE.test(billing.email)) return fail(400, 'Enter a valid email for the receipt.');
  if (!/^[A-Z]{2}$/.test(billing.country)) return fail(400, 'Choose your country.');

  const plan = typeof b.planId === 'string' ? await getPlan(env, b.planId) : null;
  if (!plan) return fail(404, 'Plan not found.');
  const q = quote(plan, interval);
  if (!q.ok) return fail(409, q.error);
  const now = Math.floor(Date.now() / 1000);
  if (plan.id === 'api-addon' && !(await addonAllowed(env, auth.userId, now))) return fail(409, 'The API add-on goes on top of an active Pro plan. Get Pro first.');

  const key = `checkout:${auth.userId}`;
  const wait = await retryAfter(env, key, 12);
  if (wait) return fail(429, 'Too many checkouts. Try again later.', { 'Retry-After': String(wait) });
  await bump(env, key, 3600);

  const mint = method === 'crypto' ? SOLANA_ASSETS[asset].mint : null;
  const open = await env.DB
    .prepare(`SELECT ${ORDER_COLUMNS} FROM orders WHERE user_id = ?1 AND plan_id = ?2 AND interval = ?3 AND provider = ?4 AND status = 'pending' AND expires_at > ?5 AND amount_cents = ?6 AND COALESCE(provider_ref, '') ${method === 'crypto' ? '= ?7' : "<> '' AND ?7 IS NULL"} ORDER BY created_at DESC LIMIT 1`)
    .bind(auth.userId, plan.id, q.interval, method, now, q.amountCents, mint)
    .first<OrderRow>();
  if (open) {
    await env.DB.prepare('UPDATE orders SET billing = ?2 WHERE id = ?1').bind(open.id, JSON.stringify(billing)).run();
    return json({ ok: true, order: await view(env, open) });
  }

  const id = crypto.randomUUID();
  let payMicro: number | null = null;
  if (method === 'crypto') {
    for (let i = 0; i < 12 && payMicro === null; i++) {
      const candidate = q.amountCents * 10_000 + 1 + Math.floor(Math.random() * 9_999);
      const clash = await env.DB.prepare(`SELECT 1 FROM orders WHERE provider = 'crypto' AND provider_ref = ?1 AND pay_micro = ?2 AND status IN ('pending', 'expired') AND expires_at > ?3`).bind(mint, candidate, now - 86_400).first();
      if (!clash) payMicro = candidate;
    }
    if (payMicro === null) return fail(503, 'Could not reserve a payment amount. Please try again.');
  }
  await env.DB
    .prepare(
      `INSERT INTO orders (id, user_id, plan_id, plan_name, interval, amount_cents, currency, provider, provider_ref, pay_micro, status, billing, created_at, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'USD', ?7, ?8, ?9, 'pending', ?10, ?11, ?12)`,
    )
    .bind(id, auth.userId, plan.id, plan.name, q.interval, q.amountCents, method, mint, payMicro, JSON.stringify(billing), now, now + PAY_WINDOW_SECONDS)
    .run();

  if (method === 'monobank') {
    const origin = ((env.APP_URL ?? '').replace(/\/+$/, '') || new URL(request.url).origin);
    const made = await createInvoice(env, {
      orderId: id, amountCents: q.amountCents, title: `Vane ${plan.name}${q.interval === 'year' ? ' (1 year)' : ' (1 month)'}`, email: billing.email, planId: plan.id,
      redirectUrl: `${origin}/checkout?order=${id}`, webHookUrl: `${origin}/api/billing/monobank`, validitySeconds: PAY_WINDOW_SECONDS,
    });
    if (!made.ok) {
      await env.DB.prepare(`UPDATE orders SET status = 'failed', note = 'invoice not created' WHERE id = ?1`).bind(id).run();
      return fail(502, made.error);
    }
    await env.DB.prepare('UPDATE orders SET provider_ref = ?2, pay_url = ?3 WHERE id = ?1').bind(id, made.invoice.invoiceId, made.invoice.pageUrl).run();
  }
  const row = await env.DB.prepare(`SELECT ${ORDER_COLUMNS} FROM orders WHERE id = ?1`).bind(id).first<OrderRow>();
  return json({ ok: true, order: await view(env, row as OrderRow) }, 201);
};

async function view(env: Env, o: OrderRow): Promise<Record<string, unknown>> {
  return { ...orderView(o), payUrl: o.provider === 'monobank' ? o.pay_url : null, crypto: cryptoDetails(env, o) };
}

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('POST');
