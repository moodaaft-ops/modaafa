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

/**
 * Optional second allowlist by Supabase user id (comma separated UUIDs). When
 * set, an operator must match BOTH the email list and the id list, so taking
 * over an allowlisted email address on a different auth user is not enough.
 */
export function parseModaafaOperatorUserIds(value = process.env.MODAAFA_OPERATOR_USER_IDS ?? '') {
  return value
    .split(',')
    .map((id) => id.trim().toLowerCase())
    .filter(Boolean);
}

export type OperatorCandidate = {
  id?: string | null;
  email?: string | null;
  email_confirmed_at?: string | null;
};

/**
 * Gate for the operations center pages and the operator actions API. Stricter
 * than isModaafaOperator: the email must also be confirmed, and when
 * MODAAFA_OPERATOR_USER_IDS is configured the user id must be on it. Pass the
 * server-side Supabase user, never anything the browser sent.
 */
export function isOperatorUser(
  user: OperatorCandidate | null | undefined,
  env: { emails?: string; userIds?: string } = {}
) {
  if (!user?.id || !user.email) return false;
  if (!isModaafaOperator(user.email, env.emails ?? process.env.MODAAFA_OPERATOR_EMAILS ?? '')) return false;
  if (!user.email_confirmed_at) return false;
  const ids = parseModaafaOperatorUserIds(env.userIds ?? process.env.MODAAFA_OPERATOR_USER_IDS ?? '');
  if (ids.length > 0 && !ids.includes(user.id.toLowerCase())) return false;
  return true;
}
