import { normalizePhone } from './phone';

export type RegistrationInput = { name: string; email: string; phoneE164: string };
export type RegistrationErrors = Partial<Record<'name' | 'email' | 'phone', string>>;

export const PHONE_ERROR_MESSAGES = {
  empty: 'اكتب رقم جوالك.',
  invalid: 'رقم الجوال غير صحيح. تأكد منه وأعد الكتابة.',
  needs_country_code: 'اكتب الرقم مع رمز الدولة، مثل 967 أو 20 قبل الرقم.',
} as const;

const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/;

/** Collapses whitespace and strips control characters so a name is safe to store and show. */
export function cleanName(value: unknown) {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function normalizeEmail(value: unknown) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function validateRegistration(
  raw: { name?: unknown; email?: unknown; phone?: unknown },
  options: { requireEmail?: boolean } = {},
): { ok: true; value: RegistrationInput } | { ok: false; errors: RegistrationErrors } {
  const errors: RegistrationErrors = {};

  const name = cleanName(raw.name);
  if (name.length < 2 || name.length > 80) errors.name = 'اكتب اسمك (من حرفين إلى 80 حرف).';

  const email = normalizeEmail(raw.email);
  if (options.requireEmail !== false && (email.length > 254 || !EMAIL_PATTERN.test(email))) {
    errors.email = 'صيغة الإيميل غير صحيحة.';
  }

  const phone = normalizePhone(raw.phone);
  if (!phone.ok) errors.phone = PHONE_ERROR_MESSAGES[phone.reason];

  if (Object.keys(errors).length > 0 || !phone.ok) return { ok: false, errors };
  return { ok: true, value: { name, email, phoneE164: phone.e164 } };
}
