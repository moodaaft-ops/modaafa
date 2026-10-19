import { randomBytes } from 'node:crypto';

/**
 * Short reference code the visitor sends inside the WhatsApp message so the
 * merchant can tie a chat back to a click. Read aloud and typed by hand, so the
 * alphabet drops the look-alikes (0 O 1 I L).
 */
export const REF_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const REF_PREFIX = 'M-';
export const REF_DEFAULT_LENGTH = 4;
export const REF_MAX_LENGTH = 6;

const REF_BODY = `[${REF_ALPHABET}]`;
const REF_FULL = new RegExp(`^M-${REF_BODY}{4,${REF_MAX_LENGTH}}$`);
// Inside a longer message the hyphen is required (plain words like MASTER must not match);
// a bare input that is only the code may drop it.
const REF_IN_TEXT = new RegExp(`(?:^|[^A-Z0-9])M-\\s?(${REF_BODY}{4,${REF_MAX_LENGTH}})(?![A-Z0-9])`);
const REF_BARE = new RegExp(`^M[-\\s]?(${REF_BODY}{4,${REF_MAX_LENGTH}})$`);

export type RandomSource = (size: number) => Uint8Array;

/** Uniform pick from the alphabet (rejects the biased tail of the byte range). */
export function generateRefCode(length = REF_DEFAULT_LENGTH, source: RandomSource = randomBytes): string {
  const size = Math.min(Math.max(Math.trunc(length), 4), REF_MAX_LENGTH);
  const limit = 256 - (256 % REF_ALPHABET.length);
  let out = '';
  while (out.length < size) {
    for (const byte of source(size * 2)) {
      if (byte >= limit) continue;
      out += REF_ALPHABET[byte % REF_ALPHABET.length];
      if (out.length === size) break;
    }
  }
  return `${REF_PREFIX}${out}`;
}

export function isValidRefCode(value: unknown): value is string {
  return typeof value === 'string' && REF_FULL.test(value);
}

const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

function latinDigits(value: string) {
  return value.replace(/[٠-٩]/g, (char) => String(ARABIC_DIGITS.indexOf(char)));
}

/**
 * Accepts what a merchant pastes or types: "m-4k7q", "M 4K7Q", "M4K7Q", Arabic
 * digits, or a whole WhatsApp message that contains the code. Returns the
 * canonical "M-4K7Q" or null.
 */
export function extractRefCode(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const cleaned = latinDigits(input)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '')
    .toUpperCase()
    .slice(0, 2000);
  const match = REF_IN_TEXT.exec(cleaned) ?? REF_BARE.exec(cleaned.trim());
  if (!match) return null;
  const code = `${REF_PREFIX}${match[1]}`;
  return isValidRefCode(code) ? code : null;
}

const SLUG_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** Public slug of a merchant's link. Not a secret, just unguessable enough to avoid enumeration. */
export function generateSlug(length = 10, source: RandomSource = randomBytes): string {
  const size = Math.min(Math.max(Math.trunc(length), 8), 16);
  const limit = 256 - (256 % SLUG_ALPHABET.length);
  let out = '';
  while (out.length < size) {
    for (const byte of source(size * 2)) {
      if (byte >= limit) continue;
      out += SLUG_ALPHABET[byte % SLUG_ALPHABET.length];
      if (out.length === size) break;
    }
  }
  return out;
}

export function isValidSlug(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z2-9]{8,16}$/.test(value);
}
