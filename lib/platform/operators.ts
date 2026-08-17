export function parseModaafaOperatorEmails(
  value = process.env.MODAAFA_OPERATOR_EMAILS ?? ''
) {
  return value
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Server-side allowlist for Modaafa operators. Never call this with an email
 * supplied by the browser; callers must use the authenticated Supabase user.
 */
export function isModaafaOperator(
  email?: string | null,
  value = process.env.MODAAFA_OPERATOR_EMAILS ?? ''
) {
  if (!email) return false;
  return parseModaafaOperatorEmails(value).includes(email.trim().toLowerCase());
}
