import { isModaafaOperator } from '@/lib/platform/operators';
import { emailList } from '@/lib/chat-first/flag';

/**
 * Account provisioning («افتحه لي») ships dark.
 * ACCOUNT_PROVISIONING:
 * - "true": every registered user.
 * - "operators": Modaafa operators plus ACCOUNT_PROVISIONING_ALLOWLIST emails.
 * - anything else or absent: off, and the onboarding screens keep the WhatsApp button.
 *
 * The email must be the authenticated server-side user's, never the browser's.
 */
export function isAccountProvisioning(
  env: Record<string, string | undefined> = process.env,
  email?: string | null
) {
  const mode = env.ACCOUNT_PROVISIONING;
  if (mode === 'true') return true;
  if (mode !== 'operators' || !email) return false;
  if (isModaafaOperator(email, env.MODAAFA_OPERATOR_EMAILS ?? '')) return true;
  return emailList(env.ACCOUNT_PROVISIONING_ALLOWLIST).includes(email.trim().toLowerCase());
}

/** The dedicated manager account id, 10 digits, or null when unset or malformed. */
export function provisioningMccId(env: Record<string, string | undefined> = process.env) {
  const digits = (env.PROVISIONING_MCC_ID ?? '').replace(/\D/g, '');
  return digits.length === 10 ? digits : null;
}

/**
 * Unlinking an accepted account from the dedicated manager account stays off
 * until the live test proves Google allows it (plan 121, phase 3).
 */
export function unlinkAfterAcceptEnabled(env: Record<string, string | undefined> = process.env) {
  return env.PROVISIONING_UNLINK_AFTER_ACCEPT === 'true';
}

/**
 * The agency's own manager account. Provisioning may run against it, but keep
 * unlink-after-accept off there: it holds clients that pay us.
 * Kept here, not imported from lib/setup/adaptive/signals.ts, so this module
 * stays light; a test pins the two constants together.
 */
export const AGENCY_MCC_ID = '7561141000';

