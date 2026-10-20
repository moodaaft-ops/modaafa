import { isModaafaOperator } from '@/lib/platform/operators';
import { emailList } from '@/lib/chat-first/flag';

/**
 * The lead-quality loop (smart WhatsApp link, lead inbox, offline upload) ships
 * dark. LEAD_LOOP_ENABLED:
 * - "true": every signed-in merchant.
 * - "operators": Modaafa operators plus LEAD_LOOP_ALLOWLIST emails.
 * - anything else or absent: off. Every route answers 404, the cron does
 *   nothing and the conversion-health tool returns exactly what it did before.
 *
 * The email must be the authenticated server-side user's, never the browser's.
 */
export function isLeadLoopEnabled(
  env: Record<string, string | undefined> = process.env,
  email?: string | null
) {
  const mode = env.LEAD_LOOP_ENABLED;
  if (mode === 'true') return true;
  if (mode !== 'operators' || !email) return false;
  if (isModaafaOperator(email, env.MODAAFA_OPERATOR_EMAILS ?? '')) return true;
  return emailList(env.LEAD_LOOP_ALLOWLIST).includes(email.trim().toLowerCase());
}

/**
 * For code with no signed-in user (the public redirect, the cron). In
 * "operators" mode the link row itself only exists for an allowed merchant, so
 * the public side serves it; in any other mode it answers 404.
 */
export function isLeadLoopServing(env: Record<string, string | undefined> = process.env) {
  return env.LEAD_LOOP_ENABLED === 'true' || env.LEAD_LOOP_ENABLED === 'operators';
}
