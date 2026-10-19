import { isModaafaOperator } from '@/lib/platform/operators';
import { emailList } from '@/lib/chat-first/flag';

/**
 * The morning guard (الحارس الصباحي) runs only when GUARD_ENABLED says so:
 * - "true": every billable account.
 * - "operators": accounts of Modaafa operators plus GUARD_ALLOWLIST emails.
 * - anything else or absent: nothing runs, nothing is read, nothing is sent.
 */
export type GuardMode = 'off' | 'all' | 'operators';

export function guardMode(env: Record<string, string | undefined> = process.env): GuardMode {
  const value = (env.GUARD_ENABLED ?? '').trim().toLowerCase();
  if (value === 'true') return 'all';
  if (value === 'operators') return 'operators';
  return 'off';
}

/** Route-level switch: is the guard on for anyone at all. */
export function isGuardEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return guardMode(env) !== 'off';
}

/** Per-owner switch: is the guard on for this account owner's email. */
export function isGuardEnabledForUser(
  email?: string | null,
  env: Record<string, string | undefined> = process.env
): boolean {
  const mode = guardMode(env);
  if (mode === 'all') return true;
  if (mode !== 'operators' || !email) return false;
  if (isModaafaOperator(email, env.MODAAFA_OPERATOR_EMAILS ?? '')) return true;
  return emailList(env.GUARD_ALLOWLIST).includes(email.trim().toLowerCase());
}
