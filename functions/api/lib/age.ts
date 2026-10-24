/**
 * Age gate for new accounts: 16+ (the highest "digital age of consent" in the EU, so it is enough everywhere).
 * The date of birth is only checked, never stored: we keep the fact "confirmed 16+ on this day" (age_confirmations).
 * Someone who enters a too-young date is blocked on this browser for a day, so retyping another date does not help.
 */
import type { Env } from '../../../types';
import { cookieDomain } from './hosts';
import { fromB64Url, toB64Url } from './encoding';

export const MIN_AGE = 16;
export const TOO_YOUNG = `Vane is for people ${MIN_AGE} and older, so we can't create an account for you.`;
export const NEED_BIRTH = 'Enter your date of birth.';

const BLOCK = 'vane_minor';
const PROOF = 'vane_age';
const BLOCK_TTL = 86400;
const PROOF_TTL = 1800;

/** 'YYYY-MM-DD' that is a real calendar day, not in the future and not before 1900. */
export function parseBirth(v: unknown, now = new Date()): { y: number; m: number; d: number } | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  if (y < 1900 || dt.getTime() > now.getTime()) return null;
  return { y, m: mo, d };
}

export function ageOf(b: { y: number; m: number; d: number }, now = new Date()): number {
  let age = now.getUTCFullYear() - b.y;
  const before = now.getUTCMonth() + 1 < b.m || (now.getUTCMonth() + 1 === b.m && now.getUTCDate() < b.d);
  if (before) age -= 1;
  return age;
}

const attrs = (request: Request, maxAge: number): string => {
  const url = new URL(request.url);
  return `Path=/${cookieDomain(url.hostname)}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${url.protocol === 'https:' ? '; Secure' : ''}`;
};

const cookieOf = (request: Request, name: string): string => {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
};

export const isBlockedMinor = (request: Request): boolean => cookieOf(request, BLOCK) === '1';
export const blockCookie = (request: Request): string => `${BLOCK}=1; ${attrs(request, BLOCK_TTL)}`;

const secretOf = (env: Env): string => env.ENCRYPTION_KEY || env.JWT_SECRET || 'vane-dev-age';

async function sign(env: Env, text: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secretOf(env)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toB64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`age\n${text}`))));
}

/** Signed "this browser entered a 16+ date" cookie: it carries a new GitHub / Google sign-up through the provider and back. */
export async function proofCookie(env: Env, request: Request): Promise<string> {
  const exp = String(Math.floor(Date.now() / 1000) + PROOF_TTL);
  return `${PROOF}=${exp}.${await sign(env, exp)}; ${attrs(request, PROOF_TTL)}`;
}

export async function hasProof(env: Env, request: Request): Promise<boolean> {
  const [exp, sig] = cookieOf(request, PROOF).split('.');
  if (!exp || !sig || !/^\d{1,12}$/.test(exp) || +exp < Date.now() / 1000) return false;
  const want = fromB64Url(await sign(env, exp)), got = (() => { try { return fromB64Url(sig); } catch { return new Uint8Array(0); } })();
  if (want.length !== got.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want[i] ^ got[i];
  return diff === 0;
}

export const clearedProofCookie = (request: Request): string => `${PROOF}=; ${attrs(request, 0)}`;

/** Remember, without the date itself, that the account holder confirmed being old enough. Best effort: a missing table never blocks a sign-up. */
export async function recordAgeConfirmed(env: Env, userId: string): Promise<void> {
  try {
    await env.DB.prepare('INSERT OR IGNORE INTO age_confirmations (user_id, min_age) VALUES (?1, ?2)').bind(userId, MIN_AGE).run();
  } catch (err) {
    console.error('age confirmation not saved', err instanceof Error ? err.message : 'unknown');
  }
}
