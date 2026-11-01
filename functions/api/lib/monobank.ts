/**
 * Monobank Acquiring: one invoice per order. The buyer is sent to Monobank's own payment page (cards, Apple Pay, Google Pay),
 * and Monobank calls our webhook when the money arrives. The webhook is signed (X-Sign, ECDSA over SHA-256) and we also ask
 * Monobank for the invoice's status before we trust it. https://api.monobank.ua/docs/acquiring.html
 */
import type { Env } from '../../../types';
import { callJson } from './httpcall';

const API = 'https://api.monobank.ua/api/merchant';

export const monobankEnabled = (env: Pick<Env, 'MONOBANK_TOKEN'>): boolean => (env.MONOBANK_TOKEN ?? '').trim().length > 8;
const CCY: Record<string, number> = { UAH: 980, USD: 840, EUR: 978 };
export const monobankCcy = (currency: string): number | null => CCY[currency.toUpperCase()] ?? null;

const headers = (env: Pick<Env, 'MONOBANK_TOKEN'>): Record<string, string> => ({ 'X-Token': (env.MONOBANK_TOKEN ?? '').trim() });

export interface MonoInvoice { invoiceId: string; pageUrl: string }

export async function createInvoice(
  env: Pick<Env, 'MONOBANK_TOKEN'>,
  o: { orderId: string; amountCents: number; ccy: number; title: string; email: string; planId: string; redirectUrl: string; webHookUrl: string; validitySeconds: number },
): Promise<{ ok: true; invoice: MonoInvoice } | { ok: false; error: string }> {
  const res = await callJson<{ invoiceId?: string; pageUrl?: string; errText?: string; errCode?: string }>(`${API}/invoice/create`, {
    method: 'POST',
    headers: headers(env),
    json: {
      amount: o.amountCents,
      ccy: o.ccy,
      redirectUrl: o.redirectUrl,
      webHookUrl: o.webHookUrl,
      validity: o.validitySeconds,
      paymentType: 'debit',
      merchantPaymInfo: {
        reference: o.orderId,
        destination: o.title.slice(0, 120),
        comment: o.title.slice(0, 120),
        customerEmails: [o.email],
        basketOrder: [{ name: o.title.slice(0, 120), qty: 1, sum: o.amountCents, total: o.amountCents, unit: 'pcs', code: o.planId.slice(0, 40) }],
      },
    },
  });
  if (!res.ok || !res.data?.invoiceId || !res.data.pageUrl) {
    const d = (res.ok ? res.data : res.data) as { errText?: string } | null;
    console.error('monobank invoice failed', res.status, d?.errText ?? '');
    return { ok: false, error: res.status === 401 || res.status === 403 ? 'The card payment is not set up correctly yet. Please use another method or try again later.' : 'The card payment page could not be created. Please try again.' };
  }
  return { ok: true, invoice: { invoiceId: res.data.invoiceId, pageUrl: res.data.pageUrl } };
}

export interface MonoStatus { invoiceId: string; status: string; amount?: number; ccy?: number; reference?: string }

export async function getInvoiceStatus(env: Pick<Env, 'MONOBANK_TOKEN'>, invoiceId: string): Promise<MonoStatus | null> {
  const res = await callJson<MonoStatus>(`${API}/invoice/status?invoiceId=${encodeURIComponent(invoiceId)}`, { headers: headers(env) });
  return res.ok && res.data && typeof res.data.status === 'string' ? res.data : null;
}

// ───────────── webhook signature ─────────────
const b64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** ECDSA signatures come DER-encoded; Web Crypto wants the raw 64 bytes (r then s). */
export function derToRaw(der: Uint8Array): Uint8Array | null {
  let i = 0;
  if (der[i++] !== 0x30) return null;
  if (der[i] & 0x80) i += der[i] & 0x7f;
  i++;
  const ints: Uint8Array[] = [];
  for (let k = 0; k < 2; k++) {
    if (der[i++] !== 0x02) return null;
    let len = der[i++];
    let part = der.slice(i, i + len);
    i += len;
    while (part.length > 32 && part[0] === 0) part = part.slice(1);
    if (part.length > 32) return null;
    const padded = new Uint8Array(32);
    padded.set(part, 32 - part.length);
    ints.push(padded);
  }
  const raw = new Uint8Array(64);
  raw.set(ints[0], 0);
  raw.set(ints[1], 32);
  return raw;
}

let cachedKey: CryptoKey | null = null;

async function loadKey(env: Pick<Env, 'MONOBANK_TOKEN'>, fresh: boolean): Promise<CryptoKey | null> {
  if (cachedKey && !fresh) return cachedKey;
  const res = await callJson<unknown>(`${API}/pubkey`, { headers: headers(env) });
  const d = res.data as { key?: unknown } | string | null;
  const text = typeof d === 'string' ? d : d && typeof d.key === 'string' ? d.key : null;
  if (!res.ok || !text) return null;
  try {
    const pem = new TextDecoder().decode(b64(text.trim()));
    const der = b64(pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, ''));
    cachedKey = await crypto.subtle.importKey('spki', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return cachedKey;
  } catch {
    return null;
  }
}

/** True only when `xSign` is Monobank's signature of exactly this raw body. The key is cached and refetched once if a check fails. */
export async function verifyWebhook(env: Pick<Env, 'MONOBANK_TOKEN'>, rawBody: string, xSign: string | null): Promise<boolean> {
  if (!xSign) return false;
  let sig: Uint8Array | null;
  try { sig = derToRaw(b64(xSign.trim())); } catch { return false; }
  if (!sig) return false;
  const data = new TextEncoder().encode(rawBody);
  for (const fresh of [false, true]) {
    const key = await loadKey(env, fresh);
    if (key && (await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, data))) return true;
  }
  return false;
}
export const resetMonobankKeyCache = (): void => { cachedKey = null; };
