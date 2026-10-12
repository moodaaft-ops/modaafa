import { isModaafaOperator } from '@/lib/platform/operators';

/**
 * Chat-first entry is shipped dark. CHAT_FIRST_ENTRY:
 * - "true": everyone signed in.
 * - "operators": Modaafa operators plus the emails in CHAT_FIRST_ALLOWLIST
 *   (comma separated). This is how the 5 measurement accounts get /start
 *   before anyone else (spec 83, PR-J9).
 * - anything else or absent: off, the routes answer 404.
 *
 * The email must come from the authenticated server-side user, never from the browser.
 */
export function isChatFirstEnabled(
  env: Record<string, string | undefined> = process.env,
  email?: string | null
) {
  const mode = env.CHAT_FIRST_ENTRY;
  if (mode === 'true') return true;
  if (mode !== 'operators' || !email) return false;
  if (isModaafaOperator(email, env.MODAAFA_OPERATOR_EMAILS ?? '')) return true;
  return emailList(env.CHAT_FIRST_ALLOWLIST).includes(email.trim().toLowerCase());
}

export function emailList(value: string | undefined) {
  return (value ?? '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}
