/**
 * Česká spořitelna's card gateway: GP webpay (operated by Global Payments Europe). Unlike ČSOB there is no server-to-server
 * "init" call: the merchant signs the order itself and sends the buyer's browser straight to the gateway, which later redirects
 * back to our return URL with a signed result. So buying a GP webpay order is one local signature, no network round trip.
 * Spec: GP webpay API HTTP, technical specification for developers (gpwebpay.cz) + Private key management and signing messages.
 */
import type { Env } from '../../../types';
import { privateKeyDer, publicKeyDer } from './csob';

type CsasEnv = Pick<Env, 'CSAS_MERCHANT_NUMBER' | 'CSAS_PRIVATE_KEY' | 'CSAS_BANK_PUBLIC_KEY' | 'CSAS_ENV'>;

/** ISO 4217 numeric codes GP webpay's CURRENCY field wants, for the currencies Vane prices plans in. */
const NUMERIC_CURRENCY: Record<string, string> = { CZK: '203', EUR: '978', USD: '840', GBP: '826', PLN: '985', HUF: '348', RON: '946', NOK: '578', SEK: '752' };

export const csasCurrencies = (env: Pick<Env, 'CSAS_CURRENCIES'>): Set<string> => {
  const listed = (env.CSAS_CURRENCIES ?? 'CZK,EUR').toUpperCase().split(',').map((c) => c.trim()).filter((c) => NUMERIC_CURRENCY[c]);
  return new Set(listed.length ? listed : ['CZK', 'EUR']);
};

export const csasEnabled = (env: CsasEnv): boolean =>
  /^\d{1,10}$/.test((env.CSAS_MERCHANT_NUMBER ?? '').trim()) && (env.CSAS_PRIVATE_KEY ?? '').includes('PRIVATE KEY') && /PUBLIC KEY|CERTIFICATE/.test(env.CSAS_BANK_PUBLIC_KEY ?? '');

const gateway = (env: Pick<Env, 'CSAS_ENV'>): string =>
  env.CSAS_ENV === 'live' ? 'https://3dsecure.gpwebpay.com/pgw/order.do' : 'https://test.3dsecure.gpwebpay.com/pgw/order.do';

export const randomOrderNumber = (): string => String(1_000_000_000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 3_000_000_000));

const enc = new TextEncoder();
const b64 = (bytes: ArrayBuffer): string => {
  const u = new Uint8Array(bytes);
  let s = '';
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s);
};
const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

const signKey = new Map<string, Promise<CryptoKey>>();
const verifyKey = new Map<string, Promise<CryptoKey>>();
const ALG = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-1' } as const;

/** Pipe-joins the given values in order, skipping any that are `undefined` (an absent optional field); an empty string is kept. */
const joinOrdered = (values: (string | undefined)[]): string => values.filter((v) => v !== undefined).join('|');

async function digest(privatePem: string, fields: (string | undefined)[]): Promise<string> {
  if (!signKey.has(privatePem)) signKey.set(privatePem, crypto.subtle.importKey('pkcs8', privateKeyDer(privatePem), ALG, false, ['sign']));
  const sig = await crypto.subtle.sign(ALG.name, await (signKey.get(privatePem) as Promise<CryptoKey>), enc.encode(joinOrdered(fields)));
  return b64(sig);
}

async function verifyDigest(publicPem: string, fields: (string | undefined)[], digestB64: string): Promise<boolean> {
  try {
    if (!verifyKey.has(publicPem)) verifyKey.set(publicPem, crypto.subtle.importKey('spki', publicKeyDer(publicPem), ALG, false, ['verify']));
    return await crypto.subtle.verify(ALG.name, await (verifyKey.get(publicPem) as Promise<CryptoKey>), unb64(digestB64), enc.encode(joinOrdered(fields)));
  } catch {
    return false;
  }
}

export interface CsasInit { orderNumber: string; amountCents: number; currency: string; description: string; merchantData: string; returnUrl: string }

/** Builds the URL that sends the buyer's browser to the GP webpay payment page. No network call: the order is only ever known to GP webpay once the buyer's browser lands there. */
export async function buildPaymentUrl(env: CsasEnv, a: CsasInit): Promise<string | null> {
  const merchantNumber = (env.CSAS_MERCHANT_NUMBER ?? '').trim();
  if (!csasEnabled(env)) return null;
  const currency = NUMERIC_CURRENCY[a.currency];
  if (!currency) return null;
  const fields: Record<string, string | undefined> = {
    MERCHANTNUMBER: merchantNumber,
    OPERATION: 'CREATE_ORDER',
    ORDERNUMBER: a.orderNumber,
    AMOUNT: String(a.amountCents),
    CURRENCY: currency,
    DEPOSITFLAG: '1',
    MERORDERNUM: undefined,
    URL: a.returnUrl,
    DESCRIPTION: a.description.slice(0, 255),
    MD: a.merchantData,
  };
  const order = ['MERCHANTNUMBER', 'OPERATION', 'ORDERNUMBER', 'AMOUNT', 'CURRENCY', 'DEPOSITFLAG', 'MERORDERNUM', 'URL', 'DESCRIPTION', 'MD'];
  const DIGEST = await digest(env.CSAS_PRIVATE_KEY ?? '', order.map((k) => fields[k]));
  const qs = new URLSearchParams();
  for (const k of order) if (fields[k] !== undefined) qs.set(k, fields[k] as string);
  qs.set('DIGEST', DIGEST);
  return `${gateway(env)}?${qs.toString()}`;
}

const RESPONSE_FIELDS = ['OPERATION', 'ORDERNUMBER', 'MERORDERNUM', 'MD', 'PRCODE', 'SRCODE', 'RESULTTEXT', 'USERPARAM1', 'ADDINFO', 'TOKEN', 'EXPIRY', 'ACSRES', 'ACCODE', 'PANPATTERN', 'DAYTOCAPTURE', 'TOKENREGSTATUS', 'ACRC', 'RRN', 'PAR', 'TRACEID'];

export interface CsasResult { orderNumber: string; paid: boolean }

/**
 * Checks the query string GP webpay sends the buyer's browser back with. Verifies both DIGEST (the response fields) and DIGEST1
 * (the same, with our own merchant number appended) against the bank's public certificate, since DIGEST1 is what proves the
 * answer was meant for this merchant number and not replayed from another one. Returns null when anything does not check out.
 */
export async function verifyReturn(env: CsasEnv, params: URLSearchParams): Promise<CsasResult | null> {
  if (!csasEnabled(env)) return null;
  const digestParam = params.get('DIGEST');
  const digest1Param = params.get('DIGEST1');
  const orderNumber = params.get('ORDERNUMBER');
  const prcode = params.get('PRCODE');
  if (!digestParam || !digest1Param || !orderNumber || prcode === null) return null;
  const present = RESPONSE_FIELDS.filter((k) => params.get(k) !== null);
  const values = present.map((k) => params.get(k) as string);
  if (!(await verifyDigest(env.CSAS_BANK_PUBLIC_KEY ?? '', values, digestParam))) return null;
  if (!(await verifyDigest(env.CSAS_BANK_PUBLIC_KEY ?? '', [...values, (env.CSAS_MERCHANT_NUMBER ?? '').trim()], digest1Param))) return null;
  return { orderNumber, paid: prcode === '0' };
}
