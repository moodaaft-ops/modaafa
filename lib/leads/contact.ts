/**
 * Cleaning what a visitor types into the exit popup. Pure.
 */

const EMAIL = /^[^\s@<>"',;:()\[\]\\]+@[^\s@<>"',;:()\[\]\\]+\.[a-z]{2,24}$/i;

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (email.length < 5 || email.length > 254) return null;
  return EMAIL.test(email) ? email : null;
}

/**
 * The mailbox behind an address, so tricks that reach the same inbox under a
 * different spelling count once: everything after a "+" in the local part, and
 * dots in gmail.com / googlemail.com. Used only to refuse a second row, never
 * as the address we send to.
 */
export function emailKey(email: string): string {
  const at = email.lastIndexOf('@');
  let local = email.slice(0, at);
  let domain = email.slice(at + 1);
  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return `${local}@${domain}`;
}

/** Cuts an IPv6 address to its /64 so one network cannot rotate through endless buckets. IPv4 is returned as is. */
export function rateLimitBucket(ip: string | null | undefined): string | null {
  const value = ip?.trim();
  if (!value) return null;
  if (!value.includes(':') || /^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(value)) return value;
  const [head, tail] = value.split('::');
  const groups = head ? head.split(':') : [];
  const rest = tail ? tail.split(':') : [];
  const full = value.includes('::') ? [...groups, ...Array(Math.max(8 - groups.length - rest.length, 0)).fill('0'), ...rest] : groups;
  return `${full.slice(0, 4).map((g) => g || '0').join(':')}::/64`;
}

/** Arabic-Indic and Persian digits to ASCII, so a phone keyboard in Arabic works. */
function asciiDigits(value: string) {
  return value
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

/**
 * Saudi mobile shapes (05XXXXXXXX, 5XXXXXXXX, 9665XXXXXXXX, 009665XXXXXXXX)
 * become 9665XXXXXXXX. Any other number needs its country code and 10 to 15
 * digits. Returns null when it cannot be a real number.
 */
export function normalizeWhatsapp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let digits = asciiDigits(value).replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  digits = digits.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (/^05\d{8}$/.test(digits)) return `966${digits.slice(1)}`;
  if (/^5\d{8}$/.test(digits)) return `966${digits}`;
  if (/^9665\d{8}$/.test(digits)) return digits;
  if (digits.startsWith('966')) return null; // Saudi code with a wrong length
  if (digits.startsWith('0')) return null; // local format of some other country
  if (/^5\d{9}$/.test(digits)) return null; // a Saudi number with one digit too many
  return /^\d{10,15}$/.test(digits) ? digits : null;
}

const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content'] as const;

/** Only short plain strings under known utm keys survive. */
export function cleanUtm(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!value || typeof value !== 'object') return out;
  for (const key of UTM_KEYS) {
    const raw = (value as Record<string, unknown>)[key];
    if (typeof raw === 'string') {
      const clean = raw.trim().slice(0, 80).replace(/[^\w\-.~ ]/g, '');
      if (clean) out[key] = clean;
    }
  }
  return out;
}

export function cleanPage(value: unknown): string {
  if (typeof value !== 'string') return '/';
  const path = value.split('?')[0].split('#')[0].slice(0, 200);
  return /^\/(?!\/)[\w\-./]*$/.test(path) ? path : '/';
}
