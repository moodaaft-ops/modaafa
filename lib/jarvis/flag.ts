import { isModaafaOperator } from '@/lib/platform/operators';
import { emailList } from '@/lib/chat-first/flag';

/**
 * The Jarvis brain answers /api/chat/start only when JARVIS_BRAIN_ENABLED says so:
 * - "true": everyone who can reach /start.
 * - "operators": Modaafa operators plus JARVIS_BRAIN_ALLOWLIST emails.
 * - anything else or absent: the rule-based planTurn answers, exactly as before.
 */
export function isJarvisBrainEnabled(
  email?: string | null,
  env: Record<string, string | undefined> = process.env
) {
  const mode = env.JARVIS_BRAIN_ENABLED;
  if (mode === 'true') return true;
  if (mode !== 'operators' || !email) return false;
  if (isModaafaOperator(email, env.MODAAFA_OPERATOR_EMAILS ?? '')) return true;
  return emailList(env.JARVIS_BRAIN_ALLOWLIST).includes(email.trim().toLowerCase());
}
