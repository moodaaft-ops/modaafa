/**
 * Phone numbers are the second dedupe anchor next to the email, so they are
 * reduced to one canonical shape (E.164) before they are compared or stored.
 *
 * Saudi numbers are accepted in every form people actually type
 * (05xxxxxxxx, 5xxxxxxxx, 9665xxxxxxxx, +9665xxxxxxxx, 009665xxxxxxxx).
 * Registration is open from any country, so other numbers must carry their
 * country code: a bare 9 or 10 digit number is ambiguous (771234567 is a Yemeni
 * mobile and also a valid Kazakh-prefixed string), and guessing would store
 * somebody else's number.
 */
export type PhoneResult =
  | { ok: true; e164: string }
  | { ok: false; reason: 'empty' | 'invalid' | 'needs_country_code' };

const EASTERN_ARABIC = '٠١٢٣٤٥٦٧٨٩';
const EXTENDED_ARABIC = '۰۱۲۳۴۵۶۷۸۹';

function toLatinDigits(value: string) {
  return value.replace(/[٠-٩۰-۹]/g, (ch) => {
    const a = EASTERN_ARABIC.indexOf(ch);
    return String(a >= 0 ? a : EXTENDED_ARABIC.indexOf(ch));
  });
}

export function normalizePhone(raw: unknown): PhoneResult {
  if (typeof raw !== 'string') return { ok: false, reason: 'empty' };
  const latin = toLatinDigits(raw).trim();
  if (!latin) return { ok: false, reason: 'empty' };

  // Only digits and a single leading "+" can survive; spaces, dashes and
  // brackets are formatting. Anything else (letters, a second +) is invalid.
  const cleaned = latin.replace(/[\s\-().]/g, '');
  if (!/^\+?[0-9]+$/.test(cleaned)) return { ok: false, reason: 'invalid' };

  let digits: string;
  let explicitInternational = false;
  if (cleaned.startsWith('+')) {
    digits = cleaned.slice(1);
    explicitInternational = true;
  } else if (cleaned.startsWith('00')) {
    digits = cleaned.slice(2);
    explicitInternational = true;
  } else {
    digits = cleaned;
  }

  if (!explicitInternational) {
    if (/^05\d{8}$/.test(digits)) digits = `966${digits.slice(1)}`;
    else if (/^5\d{8}$/.test(digits)) digits = `966${digits}`;
    else if (digits.startsWith('0') || digits.length < 11) {
      return { ok: false, reason: 'needs_country_code' };
    }
    // 11+ digits with no "+": treated as country code first (e.g. 967771234567).
  }

  const e164 = `+${digits}`;
  if (!/^\+[1-9]\d{7,14}$/.test(e164)) return { ok: false, reason: 'invalid' };
  // Saudi mobiles are exactly +9665 plus eight digits; anything else on +966 is a typo.
  if (e164.startsWith('+966') && !/^\+9665\d{8}$/.test(e164)) return { ok: false, reason: 'invalid' };
  return { ok: true, e164 };
}
