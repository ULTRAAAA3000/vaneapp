import type { Env } from '../../../types';

type CsobEnv = Pick<Env, 'CSOB_MERCHANT_ID' | 'CSOB_PRIVATE_KEY' | 'CSOB_BANK_PUBLIC_KEY' | 'CSOB_ENV'>;

export const CSOB_CURRENCIES = new Set(['CZK', 'EUR', 'USD', 'GBP', 'PLN', 'HUF', 'RON', 'NOK', 'SEK']);

export const PAID_STATUSES = new Set([4, 7, 8]);
export const FAILED_STATUSES = new Set([3, 6]);
export const REVERSED_STATUSES = new Set([5, 9, 10]);

const INIT_FIELDS = ['merchantId', 'orderNo', 'dttm', 'payOperation', 'payMethod', 'totalAmount', 'currency', 'closePayment', 'returnUrl', 'returnMethod'];
const INIT_TAIL = ['description', 'merchantData', 'customerId', 'language'];
const RESPONSE_FIELDS = ['payId', 'dttm', 'resultCode', 'resultMessage', 'paymentStatus', 'authCode', 'merchantData'];
const CART_FIELDS = ['name', 'quantity', 'amount', 'description'];

export const csobEnabled = (env: CsobEnv): boolean =>
  (env.CSOB_MERCHANT_ID ?? '').trim().length > 2 && (env.CSOB_PRIVATE_KEY ?? '').includes('PRIVATE KEY') && /PUBLIC KEY|CERTIFICATE/.test(env.CSOB_BANK_PUBLIC_KEY ?? '');

const gateway = (env: Pick<Env, 'CSOB_ENV'>): string =>
  env.CSOB_ENV === 'live' ? 'https://api.platebnibrana.csob.cz/api/v1.9' : 'https://iapi.iplatebnibrana.csob.cz/api/v1.9';

const enc = new TextEncoder();
const b64 = (bytes: ArrayBuffer | Uint8Array): string => {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s);
};
const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

const lengthBytes = (n: number): number[] => (n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >> 8, n & 255]);
const der = (tag: number, body: Uint8Array): Uint8Array => Uint8Array.from([tag, ...lengthBytes(body.length), ...body]);
const concat = (...parts: Uint8Array[]): Uint8Array => Uint8Array.from(parts.flatMap((p) => [...p]));
const RSA_ALGORITHM = Uint8Array.from([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);

function readTlv(buf: Uint8Array, at: number): { tag: number; start: number; end: number } {
  let p = at + 1;
  let len = buf[p++];
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[p++];
  }
  return { tag: buf[at], start: p, end: p + len };
}

function children(buf: Uint8Array, start: number, end: number): { tag: number; from: number; start: number; end: number }[] {
  const out = [];
  for (let at = start; at < end;) {
    const t = readTlv(buf, at);
    out.push({ tag: t.tag, from: at, start: t.start, end: t.end });
    at = t.end;
  }
  return out;
}

const pemBody = (pem: string): string => pem.replace(/\\n/g, '\n').replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
const pemKind = (pem: string): string => /-----BEGIN ([A-Z ]+)-----/.exec(pem.replace(/\\n/g, '\n'))?.[1] ?? '';

export function privateKeyDer(pem: string): Uint8Array {
  const body = unb64(pemBody(pem));
  if (pemKind(pem) !== 'RSA PRIVATE KEY') return body;
  return der(0x30, concat(Uint8Array.from([0x02, 0x01, 0x00]), RSA_ALGORITHM, der(0x04, body)));
}

export function publicKeyDer(pem: string): Uint8Array {
  const body = unb64(pemBody(pem));
  const kind = pemKind(pem);
  if (kind === 'RSA PUBLIC KEY') return der(0x30, concat(RSA_ALGORITHM, der(0x03, concat(Uint8Array.from([0]), body))));
  if (kind !== 'CERTIFICATE') return body;
  const cert = readTlv(body, 0);
  const tbs = children(body, cert.start, cert.end)[0];
  const fields = children(body, tbs.start, tbs.end);
  const first = fields[0].tag === 0xa0 ? 1 : 0;
  const spki = fields[first + 5];
  return body.slice(spki.from, spki.end);
}

const signKey = new Map<string, Promise<CryptoKey>>();
const verifyKey = new Map<string, Promise<CryptoKey>>();
const ALG = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;

export async function signText(privatePem: string, text: string): Promise<string> {
  if (!signKey.has(privatePem)) signKey.set(privatePem, crypto.subtle.importKey('pkcs8', privateKeyDer(privatePem), ALG, false, ['sign']));
  return b64(await crypto.subtle.sign(ALG.name, await (signKey.get(privatePem) as Promise<CryptoKey>), enc.encode(text)));
}

export async function verifyText(publicPem: string, text: string, signature: string): Promise<boolean> {
  try {
    if (!verifyKey.has(publicPem)) verifyKey.set(publicPem, crypto.subtle.importKey('spki', publicKeyDer(publicPem), ALG, false, ['verify']));
    return await crypto.subtle.verify(ALG.name, await (verifyKey.get(publicPem) as Promise<CryptoKey>), unb64(signature), enc.encode(text));
  } catch {
    return false;
  }
}

const joinPresent = (values: unknown[]): string => values.filter((v) => v !== undefined && v !== null && v !== '').map(String).join('|');

export function initBase(p: Record<string, unknown>): string {
  const cart = (p.cart as Record<string, unknown>[] | undefined) ?? [];
  return joinPresent([...INIT_FIELDS.map((k) => p[k]), ...cart.flatMap((item) => CART_FIELDS.map((k) => item[k])), ...INIT_TAIL.map((k) => p[k])]);
}

export const responseBase = (p: Record<string, unknown>): string => joinPresent(RESPONSE_FIELDS.map((k) => p[k]));
export const requestBase = (merchantId: string, payId: string, dttm: string): string => joinPresent([merchantId, payId, dttm]);

export function stamp(date = new Date()): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Prague', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(date).map((x) => [x.type, x.value]),
  );
  return `${parts.year}${parts.month}${parts.day}${parts.hour}${parts.minute}${parts.second}`;
}

export const randomOrderNo = (): string => String(1_000_000_000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 3_000_000_000));

async function call(env: CsobEnv, method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${gateway(env)}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!res) return null;
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !data) {
    console.error('csob call failed', method, path.split('/')[1], res.status);
    return null;
  }
  const signature = typeof data.signature === 'string' ? data.signature : '';
  if (!signature || !(await verifyText(env.CSOB_BANK_PUBLIC_KEY ?? '', responseBase(data), signature))) {
    console.error('csob response signature is not valid', method, path.split('/')[1]);
    return null;
  }
  return data;
}

export interface CsobInit { orderId: string; orderNo: string; amountCents: number; currency: string; itemName: string; description: string; returnUrl: string }

export async function initPayment(env: CsobEnv, a: CsobInit): Promise<{ ok: true; payId: string } | { ok: false }> {
  const request: Record<string, unknown> = {
    merchantId: env.CSOB_MERCHANT_ID,
    orderNo: a.orderNo,
    dttm: stamp(),
    payOperation: 'payment',
    payMethod: 'card',
    totalAmount: a.amountCents,
    currency: a.currency,
    closePayment: true,
    returnUrl: a.returnUrl,
    returnMethod: 'GET',
    cart: [{ name: a.itemName.slice(0, 20), quantity: 1, amount: a.amountCents }],
    description: a.description.slice(0, 255),
    merchantData: btoa(a.orderId),
    language: 'EN',
  };
  request.signature = await signText(env.CSOB_PRIVATE_KEY ?? '', initBase(request));
  const data = await call(env, 'POST', '/payment/init', request);
  if (!data || data.resultCode !== 0 || typeof data.payId !== 'string' || !data.payId) return { ok: false };
  return { ok: true, payId: data.payId };
}

async function signedPath(env: CsobEnv, area: string, payId: string): Promise<string> {
  const dttm = stamp();
  const signature = await signText(env.CSOB_PRIVATE_KEY ?? '', requestBase(env.CSOB_MERCHANT_ID ?? '', payId, dttm));
  return `/payment/${area}/${encodeURIComponent(env.CSOB_MERCHANT_ID ?? '')}/${encodeURIComponent(payId)}/${dttm}/${encodeURIComponent(signature)}`;
}

export async function processUrl(env: CsobEnv, payId: string): Promise<string> {
  return `${gateway(env)}${await signedPath(env, 'process', payId)}`;
}

export async function paymentStatus(env: CsobEnv, payId: string): Promise<{ resultCode: number; status: number | null } | null> {
  const data = await call(env, 'GET', await signedPath(env, 'status', payId));
  if (!data || typeof data.resultCode !== 'number') return null;
  return { resultCode: data.resultCode, status: typeof data.paymentStatus === 'number' ? data.paymentStatus : null };
}
