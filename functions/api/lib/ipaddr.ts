/** IPv4 / IPv6 address and CIDR parsing (no dependencies) for the blocklist. */

export interface ParsedIp {
  v: 4 | 6;
  n: bigint;
}
export interface ParsedCidr extends ParsedIp {
  bits: number;
}

function parseV4(s: string): bigint | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  let n = 0n;
  for (let i = 1; i <= 4; i++) {
    const o = Number(m[i]);
    if (o > 255) return null;
    n = (n << 8n) | BigInt(o);
  }
  return n;
}

function parseV6(input: string): bigint | null {
  let s = input.toLowerCase();
  if (s.includes('%') || !s.includes(':')) return null;
  if (s.includes('.')) {
    // embedded IPv4 tail, e.g. ::ffff:1.2.3.4
    const cut = s.lastIndexOf(':');
    const v4 = parseV4(s.slice(cut + 1));
    if (v4 === null) return null;
    s = `${s.slice(0, cut + 1)}${((v4 >> 16n) & 0xffffn).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const groups = (p: string) => (p === '' ? [] : p.split(':'));
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  let all: string[];
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    all = head;
  } else {
    if (head.length + tail.length > 7) return null;
    all = [...head, ...Array<string>(8 - head.length - tail.length).fill('0'), ...tail];
  }
  let n = 0n;
  for (const g of all) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  return n;
}

/** Parses an address; IPv4-mapped IPv6 (::ffff:1.2.3.4) is treated as the IPv4 address. */
export function parseIp(raw: string): ParsedIp | null {
  const s = raw.trim();
  const v4 = parseV4(s);
  if (v4 !== null) return { v: 4, n: v4 };
  const v6 = parseV6(s);
  if (v6 === null) return null;
  if (v6 >> 32n === 0xffffn) return { v: 4, n: v6 & 0xffffffffn };
  return { v: 6, n: v6 };
}

export function parseCidr(raw: string): ParsedCidr | null {
  const [addr, len, extra] = raw.trim().split('/');
  if (extra !== undefined || len === undefined || !/^\d{1,3}$/.test(len)) return null;
  const ip = parseIp(addr);
  if (!ip) return null;
  const bits = Number(len);
  if (bits > (ip.v === 4 ? 32 : 128)) return null;
  return { ...ip, bits };
}

export function inCidr(ip: ParsedIp, c: ParsedCidr): boolean {
  if (ip.v !== c.v) return false;
  const shift = BigInt((c.v === 4 ? 32 : 128) - c.bits);
  return ip.n >> shift === c.n >> shift;
}

/** Loopback, private (RFC 1918), link-local and unique-local addresses: our own machines and internal proxies, never "attackers". */
export function isPrivateIp(raw: string): boolean {
  const ip = parseIp(raw);
  if (!ip) return false;
  if (ip.v === 4) {
    const a = Number(ip.n >> 24n), b = Number((ip.n >> 16n) & 0xffn);
    return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  return ip.n === 1n || ip.n === 0n || (ip.n >> 121n) === 0x7en /* fc00::/7 */ || (ip.n >> 118n) === 0x3fan /* fe80::/10 */;
}

export const sameIp = (a: ParsedIp, b: ParsedIp): boolean => a.v === b.v && a.n === b.n;
