import { isModaafaOperator } from '@/lib/platform/operators';
import { emailList } from '@/lib/chat-first/flag';
import { isSimpleExperience } from '@/lib/setup/mode';

/**
 * Adaptive onboarding is shipped dark and rides on top of the simple
 * experience (it changes /onboarding, which only exists there).
 * ADAPTIVE_ONBOARDING:
 * - "true": everyone on the simple experience.
 * - "operators": Modaafa operators plus ADAPTIVE_ONBOARDING_ALLOWLIST emails.
 * - anything else or absent: the ten fixed questions, unchanged.
 *
 * The email must be the authenticated server-side user's, never the browser's.
 */
export function isAdaptiveOnboarding(
  env: Record<string, string | undefined> = process.env,
  email?: string | null
) {
  if (!isSimpleExperience(env, email)) return false;
  const mode = env.ADAPTIVE_ONBOARDING;
  if (mode === 'true') return true;
  if (mode !== 'operators' || !email) return false;
  if (isModaafaOperator(email, env.MODAAFA_OPERATOR_EMAILS ?? '')) return true;
  return emailList(env.ADAPTIVE_ONBOARDING_ALLOWLIST).includes(email.trim().toLowerCase());
}
