import { toLatinDigits } from '@/lib/ads/validators';
export const merchantPhoneEnabled = (env: NodeJS.ProcessEnv = process.env) => env.MERCHANT_PHONE_ENABLED === 'true';
/** Settings takes the local mobile shape explicitly, stores E.164. */
export function merchantPhoneE164(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = toLatinDigits(raw).trim();
  return /^05\d{8}$/.test(value) ? `+966${value.slice(1)}` : null;
}
