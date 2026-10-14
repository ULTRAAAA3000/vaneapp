/**
 * Password hashing with Web Crypto (PBKDF2-HMAC-SHA256).
 *
 * Stored format:  pbkdf2-sha256$<iterations>$<salt b64url>$<hash b64url>
 * The iteration count is stored with every hash, so it can be raised later without breaking
 * existing users.
 *
 * NOTE: Cloudflare Workers refuses PBKDF2 above 100,000 iterations, so that is the ceiling
 * (OWASP's current advice is higher; the mitigation here is the login rate limit + long random salt).
 */
import { fromB64Url, toB64Url } from './encoding';

export const PBKDF2_ITERATIONS = 100_000;
const SALT_LEN = 16;
const HASH_BITS = 256;
const enc = new TextEncoder();

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password.normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, HASH_BITS);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const hash = await derive(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${toB64Url(salt)}$${toB64Url(hash)}`;
}

/** Compares in constant time (no early exit on the first differing byte). */
function safeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const [scheme, iterStr, saltStr, hashStr] = stored.split('$');
    if (scheme !== 'pbkdf2-sha256') return false;
    const iterations = Number(iterStr);
    if (!Number.isInteger(iterations) || iterations < 1 || iterations > PBKDF2_ITERATIONS) return false;
    const expected = fromB64Url(hashStr);
    const actual = await derive(password, fromB64Url(saltStr), iterations);
    return safeEqual(actual, expected);
  } catch {
    return false;
  }
}

/**
 * Spend the same CPU as a real check. Called when the email doesn't exist, so response time
 * doesn't reveal which emails are registered.
 */
export async function burnPasswordCheck(password: string): Promise<void> {
  await derive(password, new Uint8Array(SALT_LEN), PBKDF2_ITERATIONS);
}
