/**
 * Which addresses Vane is willing to call on a person's behalf (webhook receivers, image links that are downloaded or handed to a network).
 * Rules: https, no password, port 443, a real public host name (no IP addresses in any spelling, no "localhost", no private-network
 * suffixes). Vane's own hosts are refused, because a link back into Vane could be used to read its internals or to loop forever;
 * the only own addresses that are fine are the public file links a person already gets from Vane (`allowOwn`).
 */
export const ROOT = 'vaneapp.dev';

/** Names that only make sense inside a private network. */
const PRIVATE_SUFFIXES = /(^|\.)(localhost|local|internal|lan|home|home\.arpa|intranet|corp|test|invalid|example|onion|nip\.io|sslip\.io|xip\.io|localtest\.me|lvh\.me)$/;

export const isOwnHost = (host: string): boolean => host === ROOT || host.endsWith(`.${ROOT}`);

/** The URL as a string when it may be called, otherwise null. `allowOwn` lists path prefixes on Vane's own hosts that are acceptable. */
export function publicHttpsUrl(v: unknown, allowOwn: string[] = []): string | null {
  if (typeof v !== 'string' || v.length > 2048 || /[\u0000- \u007f]/.test(v)) return null;
  let u: URL;
  try { u = new URL(v); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return null;
  const host = u.hostname.toLowerCase().replace(/\.+$/, '');   // "localhost." is the same name
  if (!host || host.startsWith('[') || host.length > 253) return null;
  if (isOwnHost(host)) return allowOwn.some((p) => u.pathname.startsWith(p)) ? u.toString() : null;
  if (!host.includes('.') || /^[0-9.]+$/.test(host) || /^0x[0-9a-f]+$/i.test(host.split('.')[0]) && /^[0-9a-fx.]+$/i.test(host)) return null;   // IP addresses in any form
  if (/(^|\.)\d{1,3}[.-]\d{1,3}[.-]\d{1,3}[.-]\d{1,3}(\.|$)/.test(host)) return null;                                                          // 10-0-0-1.example.com style
  if (PRIVATE_SUFFIXES.test(host)) return null;
  return u.toString();
}
