import type { Env } from '../../../types';

type PayPalEnv = Pick<Env, 'DB' | 'PAYPAL_CLIENT_ID' | 'PAYPAL_CLIENT_SECRET' | 'PAYPAL_WEBHOOK_ID' | 'PAYPAL_ENV'>;

export const paypalEnabled = (env: Pick<Env, 'PAYPAL_CLIENT_ID' | 'PAYPAL_CLIENT_SECRET'>): boolean =>
  (env.PAYPAL_CLIENT_ID ?? '').trim().length > 8 && (env.PAYPAL_CLIENT_SECRET ?? '').trim().length > 8;

export const PAYPAL_CURRENCIES = new Set(['USD', 'EUR', 'CZK', 'GBP', 'PLN', 'CHF', 'SEK', 'DKK', 'NOK', 'HUF', 'CAD', 'AUD']);

const base = (env: Pick<Env, 'PAYPAL_ENV'>): string => (env.PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com');

let cached: { key: string; token: string; until: number } | null = null;

async function token(env: PayPalEnv): Promise<string | null> {
  const key = `${env.PAYPAL_ENV}:${env.PAYPAL_CLIENT_ID}`;
  const now = Date.now();
  if (cached && cached.key === key && cached.until > now + 30_000) return cached.token;
  const res = await fetch(`${base(env)}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`)}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!res || !res.ok) return null;
  const data = (await res.json().catch(() => null)) as { access_token?: string; expires_in?: number } | null;
  if (!data?.access_token) return null;
  cached = { key, token: data.access_token, until: now + (data.expires_in ?? 300) * 1000 };
  return data.access_token;
}

async function call<T>(env: PayPalEnv, method: string, path: string, body?: unknown, requestId?: string): Promise<{ ok: true; data: T } | { ok: false; status: number }> {
  const t = await token(env);
  if (!t) return { ok: false, status: 0 };
  const res = await fetch(`${base(env)}${path}`, {
    method,
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json', ...(requestId ? { 'PayPal-Request-Id': requestId } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!res) return { ok: false, status: 0 };
  if (!res.ok) {
    console.error('paypal call failed', method, path.split('?')[0], res.status);
    return { ok: false, status: res.status };
  }
  const data = (res.status === 204 ? {} : await res.json().catch(() => ({}))) as T;
  return { ok: true, data };
}

export const toValue = (cents: number): string => (cents / 100).toFixed(2);
export const toCents = (value: unknown): number | null => {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

async function remembered(env: PayPalEnv, key: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT paypal_id FROM paypal_plans WHERE key = ?1').bind(key).first<{ paypal_id: string }>();
  return row?.paypal_id ?? null;
}

async function remember(env: PayPalEnv, key: string, id: string): Promise<string> {
  await env.DB.prepare('INSERT OR IGNORE INTO paypal_plans (key, paypal_id) VALUES (?1, ?2)').bind(key, id).run();
  return (await remembered(env, key)) ?? id;
}

async function productId(env: PayPalEnv): Promise<string | null> {
  const have = await remembered(env, 'product');
  if (have) return have;
  const made = await call<{ id?: string }>(env, 'POST', '/v1/catalogs/products', { name: 'Vane', type: 'SERVICE', category: 'SOFTWARE' }, crypto.randomUUID());
  return made.ok && made.data.id ? remember(env, 'product', made.data.id) : null;
}

export async function billingPlanId(env: PayPalEnv, name: string, cents: number, currency: string, interval: 'month' | 'year'): Promise<string | null> {
  const key = `${currency}:${cents}:${interval}`;
  const have = await remembered(env, key);
  if (have) return have;
  const product = await productId(env);
  if (!product) return null;
  const made = await call<{ id?: string }>(env, 'POST', '/v1/billing/plans', {
    product_id: product,
    name: name.slice(0, 120),
    status: 'ACTIVE',
    billing_cycles: [{
      frequency: { interval_unit: interval === 'year' ? 'YEAR' : 'MONTH', interval_count: 1 },
      tenure_type: 'REGULAR', sequence: 1, total_cycles: 0,
      pricing_scheme: { fixed_price: { value: toValue(cents), currency_code: currency } },
    }],
    payment_preferences: { auto_bill_outstanding: true, setup_fee_failure_action: 'CANCEL', payment_failure_threshold: 3 },
  }, crypto.randomUUID());
  return made.ok && made.data.id ? remember(env, key, made.data.id) : null;
}

export async function createSubscription(
  env: PayPalEnv,
  a: { planId: string; orderId: string; email: string; returnUrl: string; cancelUrl: string },
): Promise<{ ok: true; id: string; approveUrl: string } | { ok: false }> {
  const made = await call<{ id?: string; links?: { rel: string; href: string }[] }>(env, 'POST', '/v1/billing/subscriptions', {
    plan_id: a.planId,
    custom_id: a.orderId,
    subscriber: { email_address: a.email },
    application_context: { brand_name: 'Vane', shipping_preference: 'NO_SHIPPING', user_action: 'SUBSCRIBE_NOW', return_url: a.returnUrl, cancel_url: a.cancelUrl },
  }, a.orderId);
  const approve = made.ok ? made.data.links?.find((l) => l.rel === 'approve')?.href : null;
  if (!made.ok || !made.data.id || !approve || !approve.startsWith('https://')) return { ok: false };
  return { ok: true, id: made.data.id, approveUrl: approve };
}

export interface PaypalPayment { id: string; cents: number; currency: string }

export async function completedPayments(env: PayPalEnv, subscriptionId: string, sinceSeconds: number): Promise<PaypalPayment[]> {
  const from = new Date((sinceSeconds - 3600) * 1000).toISOString().replace(/\.\d{3}Z$/, '.000Z');
  const to = new Date(Date.now() + 3600_000).toISOString().replace(/\.\d{3}Z$/, '.000Z');
  const res = await call<{ transactions?: { id?: string; status?: string; amount_with_breakdown?: { gross_amount?: { value?: string; currency_code?: string } } }[] }>(
    env, 'GET', `/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}/transactions?start_time=${from}&end_time=${to}`,
  );
  if (!res.ok) return [];
  const out: PaypalPayment[] = [];
  for (const t of res.data.transactions ?? []) {
    const cents = toCents(t.amount_with_breakdown?.gross_amount?.value);
    const currency = t.amount_with_breakdown?.gross_amount?.currency_code;
    if (t.status === 'COMPLETED' && t.id && cents !== null && currency) out.push({ id: t.id, cents, currency });
  }
  return out;
}

export async function verifyWebhook(env: PayPalEnv, headers: Headers, raw: string): Promise<boolean> {
  const webhookId = (env.PAYPAL_WEBHOOK_ID ?? '').trim();
  const h = (name: string): string => headers.get(name) ?? '';
  if (!webhookId || !h('paypal-transmission-sig') || !h('paypal-cert-url')) return false;
  const t = await token(env);
  if (!t) return false;
  const body =
    `{"auth_algo":${JSON.stringify(h('paypal-auth-algo'))},"cert_url":${JSON.stringify(h('paypal-cert-url'))},"transmission_id":${JSON.stringify(h('paypal-transmission-id'))},` +
    `"transmission_sig":${JSON.stringify(h('paypal-transmission-sig'))},"transmission_time":${JSON.stringify(h('paypal-transmission-time'))},"webhook_id":${JSON.stringify(webhookId)},"webhook_event":${raw}}`;
  const res = await fetch(`${base(env)}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!res || !res.ok) return false;
  const data = (await res.json().catch(() => null)) as { verification_status?: string } | null;
  return data?.verification_status === 'SUCCESS';
}
