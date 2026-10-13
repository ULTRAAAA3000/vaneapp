/**
 * Encryption of channel credentials (Telegram bot tokens etc.) before they hit D1.
 *
 * Algorithm : AES-GCM, 256-bit key, 96-bit random IV (Web Crypto, `crypto.subtle`)
 * Key       : derived with HKDF-SHA256 from `secretKey` + a random 16-byte salt PER MESSAGE,
 *             so every ciphertext is encrypted under its own key.
 * Format    : "v1." + base64url( salt[16] | iv[12] | ciphertext+tag )
 *             The version prefix lets us rotate the scheme later without a guessing game.
 *
 * `secretKey` MUST be a high-entropy random secret (HKDF does not slow down brute force,
 * it is not a password hash). Generate one with:   openssl rand -base64 32
 *
 * GCM is authenticated: a modified ciphertext, or a wrong key, makes decryption throw.
 */
import { fromB64Url, toB64Url } from './encoding';

const VERSION = 'v1';
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const MIN_SECRET_LEN = 32;

const enc = new TextEncoder();
const dec = new TextDecoder();
const HKDF_INFO = enc.encode('vane:credentials:aes-gcm-256:v1');

async function deriveKey(secretKey: string, salt: Uint8Array, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  if (typeof secretKey !== 'string' || secretKey.length < MIN_SECRET_LEN) {
    throw new Error(`ENCRYPTION_KEY must be at least ${MIN_SECRET_LEN} characters`);
  }
  const ikm = await crypto.subtle.importKey('raw', enc.encode(secretKey), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: HKDF_INFO },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  );
}

export async function encryptToken(text: string, secretKey: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const key = await deriveKey(secretKey, salt, 'encrypt');
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(text)));

  const packed = new Uint8Array(SALT_LEN + IV_LEN + ct.length);
  packed.set(salt, 0);
  packed.set(iv, SALT_LEN);
  packed.set(ct, SALT_LEN + IV_LEN);
  return `${VERSION}.${toB64Url(packed)}`;
}

export async function decryptToken(cipherText: string, secretKey: string): Promise<string> {
  // One generic error for every failure mode: no oracle for what exactly was wrong.
  const fail = () => new Error('Decryption failed');
  try {
    const dot = cipherText.indexOf('.');
    if (dot < 0 || cipherText.slice(0, dot) !== VERSION) throw fail();

    const packed = fromB64Url(cipherText.slice(dot + 1));
    if (packed.length < SALT_LEN + IV_LEN + TAG_LEN) throw fail();

    const salt = packed.slice(0, SALT_LEN);
    const iv = packed.slice(SALT_LEN, SALT_LEN + IV_LEN);
    const ct = packed.slice(SALT_LEN + IV_LEN);

    const key = await deriveKey(secretKey, salt, 'decrypt');
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return dec.decode(pt);
  } catch (e) {
    // Config errors (missing/short key) are the developer's problem: keep their message.
    if (e instanceof Error && e.message.startsWith('ENCRYPTION_KEY')) throw e;
    throw fail();
  }
}
