import { isIP } from 'node:net';

/**
 * SSRF guard for the landing page check. The URLs come from a merchant's ads,
 * so they are untrusted: a final URL can point at localhost, at a cloud
 * metadata service or at a private network. Every URL, and every redirect hop,
 * goes through parseCheckableUrl and resolvePublicAddresses before a byte is
 * requested.
 */

export type Resolver = (hostname: string) => Promise<string[]>;

export type UnsafeUrlCode =
  | 'bad_url'
  | 'not_https'
  | 'credentials_in_url'
  | 'bad_port'
  | 'ip_literal'
  | 'blocked_host'
  | 'dns_failed'
  | 'no_address'
  | 'private_address';

export class UnsafeUrlError extends Error {
  readonly code: UnsafeUrlCode;
  constructor(code: UnsafeUrlCode, message?: string) {
    super(message ?? code);
    this.name = 'UnsafeUrlError';
    this.code = code;
  }
}

const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.lan', '.home.arpa', '.intranet', '.corp'];
const BLOCKED_NAMES = new Set(['localhost', 'metadata', 'metadata.google.internal', 'instance-data']);

// ---------------------------------------------------------------------------
// IP classification
// ---------------------------------------------------------------------------

function parseIpv4(value: string): number[] | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    bytes.push(n);
  }
  return bytes;
}

function isBlockedIpv4Bytes([a, b, c]: number[]): boolean {
  if (a === 0) return true; // "this network"
  if (a === 10) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier grade NAT
  if (a === 127) return true;
  if (a === 169 && b === 254) return true; // link local, includes 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

/** Expands an IPv6 text form into 16 bytes. Null when it is not valid IPv6 (zone ids are refused). */
function parseIpv6(value: string): number[] | null {
  if (value.includes('%')) return null;
  let text = value.toLowerCase();
  // Embedded IPv4 tail (::ffff:1.2.3.4).
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIpv4(tail);
    if (!v4) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    text = `${text.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const groups = halves.length === 1 ? head : [...head, ...Array(missing).fill('0'), ...rest];
  const bytes: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    const n = parseInt(group, 16);
    bytes.push(n >> 8, n & 0xff);
  }
  return bytes.length === 16 ? bytes : null;
}

function isBlockedIpv6Bytes(b: number[]): boolean {
  const allZeroUntil = (end: number) => b.slice(0, end).every((x) => x === 0);
  if (allZeroUntil(15) && (b[15] === 0 || b[15] === 1)) return true; // :: and ::1
  if (allZeroUntil(10) && b[10] === 0xff && b[11] === 0xff) return isBlockedIpv4Bytes(b.slice(12)); // ::ffff:a.b.c.d
  if (allZeroUntil(12)) return true; // deprecated IPv4 compatible
  // 64:ff9b::/96 NAT64: judged by the embedded IPv4. 64:ff9b:1::/48 is local use.
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
    if (b[4] === 0 && b[5] === 0 && b.slice(6, 12).every((x) => x === 0)) return isBlockedIpv4Bytes(b.slice(12));
    return true;
  }
  if (b[0] === 0x20 && b[1] === 0x02) return isBlockedIpv4Bytes(b.slice(2, 6)); // 6to4
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return true; // Teredo
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true; // documentation
  // Only global unicast 2000::/3 is allowed past this point; fc00::/7, fe80::/10, ff00::/8 and the rest are refused.
  return (b[0] & 0xe0) !== 0x20;
}

/** True for any address a public web page must never be fetched from. Anything unparsable counts as blocked. */
export function isBlockedIp(ip: string): boolean {
  const text = String(ip ?? '').trim().replace(/^\[|\]$/g, '');
  const family = isIP(text);
  if (family === 4) {
    const bytes = parseIpv4(text);
    return !bytes || isBlockedIpv4Bytes(bytes);
  }
  if (family === 6) {
    const bytes = parseIpv6(text);
    return !bytes || isBlockedIpv6Bytes(bytes);
  }
  return true;
}

// ---------------------------------------------------------------------------
// URL and DNS checks
// ---------------------------------------------------------------------------

/**
 * https only, no credentials, port 443 only, a real DNS name (no IP literal in
 * any spelling: the URL parser has already turned 2130706433 or 0x7f.1 into
 * 127.0.0.1, which is then refused as a literal).
 */
export function parseCheckableUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new UnsafeUrlError('bad_url');
  }
  if (url.protocol !== 'https:') throw new UnsafeUrlError('not_https');
  if (url.username || url.password) throw new UnsafeUrlError('credentials_in_url');
  if (url.port && url.port !== '443') throw new UnsafeUrlError('bad_port');

  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host.length > 253) throw new UnsafeUrlError('bad_url');
  if (host.startsWith('[') || isIP(host) !== 0) throw new UnsafeUrlError('ip_literal');
  if (!host.includes('.')) throw new UnsafeUrlError('blocked_host');
  if (BLOCKED_NAMES.has(host) || BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new UnsafeUrlError('blocked_host');
  }
  url.hash = '';
  return url;
}

export type PublicAddress = { address: string; family: 4 | 6 };

/**
 * Resolves the host and refuses it when ANY answer is private, loopback, link
 * local or reserved. One bad record among good ones is enough: the connection
 * is pinned to the first address the caller gets back, but a mixed answer is
 * how DNS rebinding tricks are staged, so it is rejected whole.
 */
export async function resolvePublicAddresses(hostname: string, resolve: Resolver): Promise<PublicAddress[]> {
  let answers: string[];
  try {
    answers = await resolve(hostname);
  } catch {
    throw new UnsafeUrlError('dns_failed');
  }
  const addresses = (Array.isArray(answers) ? answers : []).map((a) => String(a).trim()).filter(Boolean);
  if (addresses.length === 0) throw new UnsafeUrlError('no_address');
  if (addresses.some(isBlockedIp)) throw new UnsafeUrlError('private_address');
  return addresses.map((address) => ({ address, family: isIP(address) === 6 ? 6 : 4 }));
}
