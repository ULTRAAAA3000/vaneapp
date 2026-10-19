/**
 * Google Search Console through a service account (no OAuth screen, nothing for a user to click):
 *   1. Google Cloud → create a service account, enable the "Google Search Console API", download its JSON key
 *   2. Search Console → Settings → Users and permissions → add the service account's e-mail (Restricted is enough)
 *   3. secrets: GSC_SERVICE_ACCOUNT = the whole JSON, GSC_SITE_URL = "sc-domain:vaneapp.dev" (or "https://vaneapp.dev/")
 */
import type { Env } from '../../../types';
import { fromB64Url, toB64Url } from './encoding';

const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const enc = new TextEncoder();

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export function readServiceAccount(env: Env): ServiceAccount | null {
  if (!env.GSC_SERVICE_ACCOUNT) return null;
  try {
    const sa = JSON.parse(env.GSC_SERVICE_ACCOUNT) as Partial<ServiceAccount>;
    return typeof sa.client_email === 'string' && typeof sa.private_key === 'string' ? (sa as ServiceAccount) : null;
  } catch {
    return null;
  }
}

export const gscSite = (env: Env): string => env.GSC_SITE_URL || 'sc-domain:vaneapp.dev';

async function signJwt(sa: ServiceAccount): Promise<string> {
  const pem = sa.private_key.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  const key = await crypto.subtle.importKey(
    'pkcs8',
    fromB64Url(pem.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const iat = Math.floor(Date.now() / 1000);
  const head = toB64Url(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claim = toB64Url(enc.encode(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: sa.token_uri ?? TOKEN_URL, iat, exp: iat + 3600 })));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(`${head}.${claim}`));
  return `${head}.${claim}.${toB64Url(new Uint8Array(sig))}`;
}

let token: { value: string; exp: number } | null = null;

async function accessToken(sa: ServiceAccount): Promise<string> {
  if (token && token.exp > Date.now() + 60_000) return token.value;
  const res = await fetch(sa.token_uri ?? TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: await signJwt(sa) }),
    signal: AbortSignal.timeout(8000),
  });
  const data = (await res.json()) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!res.ok || !data.access_token) throw new Error(data.error_description ?? `Google token error ${res.status}`);
  token = { value: data.access_token, exp: Date.now() + (data.expires_in ?? 3600) * 1000 };
  return token.value;
}

export interface GscRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export async function searchAnalytics(
  env: Env,
  q: { startDate: string; endDate: string; dimensions: string[]; rowLimit?: number },
): Promise<GscRow[]> {
  const sa = readServiceAccount(env);
  if (!sa) throw new Error('Search Console is not configured');
  const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(gscSite(env))}/searchAnalytics/query`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${await accessToken(sa)}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ...q, rowLimit: q.rowLimit ?? 25 }),
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await res.json()) as { rows?: GscRow[]; error?: { message?: string } };
  if (!res.ok) throw new Error(data.error?.message ?? `Search Console error ${res.status}`);
  return data.rows ?? [];
}
