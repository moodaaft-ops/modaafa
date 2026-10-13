import { createHash } from 'node:crypto';

/**
 * Identity keys for the one free trial.
 *
 * The durable trial ledger (`billing_trial_ledger`) is keyed on a hash of the
 * email. A hash of the raw address is trivially dodged with the same inbox:
 * `name+1@gmail.com`, `na.me@gmail.com` and `name@googlemail.com` all deliver to
 * `name@gmail.com`. `normalizeTrialEmail` collapses those to one address before
 * hashing.
 *
 * The SQL function `public.trial_email_key` (db/migrations/20261013_trial_abuse_guards.sql)
 * implements the SAME normalisation for the backfill. If you change one, change
 * the other, and the fixtures in tests/trial-identity.test.ts that pin both.
 */

const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/**
 * Well-known throwaway inbox providers. Deliberately short and exact-match: a
 * long, guessed list blocks real customers, and the ads-account lock is the
 * primary guard anyway. Subdomains are not matched.
 */
export const DISPOSABLE_EMAIL_DOMAINS: readonly string[] = [
  'mailinator.com',
  'guerrillamail.com',
  '10minutemail.com',
  'temp-mail.org',
  'tempmail.com',
  'yopmail.com',
  'trashmail.com',
  'sharklasers.com',
  'getnada.com',
  'dispostable.com',
  'maildrop.cc',
  'mohmal.com',
  'emailondeck.com',
  'fakeinbox.com',
  'throwawaymail.com',
  'mintemail.com',
];

const DISPOSABLE_SET = new Set(DISPOSABLE_EMAIL_DOMAINS);

function sha256Hex(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * The address a trial is counted against: trimmed and lowercased; any `+tag`
 * removed from the local part; and, for Gmail (gmail.com / googlemail.com), the
 * dots removed from the local part and the domain unified to gmail.com.
 *
 * A local part that would become empty after removing the tag (`+tag@x.com`) is
 * left untouched so unrelated odd addresses do not collapse into one key. An
 * input with no `@` is returned trimmed and lowercased.
 */
export function normalizeTrialEmail(email: string) {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf('@');
  if (at < 0) return trimmed;

  let local = trimmed.slice(0, at);
  let domain = trimmed.slice(at + 1);

  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);

  if (GMAIL_DOMAINS.has(domain)) {
    local = local.replaceAll('.', '');
    domain = 'gmail.com';
  }

  return `${local}@${domain}`;
}

/** The key the ledger used before normalisation existed: sha256(trim + lowercase). */
export function legacyTrialEmailKey(email: string) {
  return sha256Hex(email.trim().toLowerCase());
}

/** Key of the normalised address; equals `public.trial_email_key(email)` in SQL. */
export function normalizedTrialEmailKey(email: string) {
  return sha256Hex(normalizeTrialEmail(email));
}

/**
 * Every key a ledger lookup must check for this email, de-duplicated: the legacy
 * key (rows written before normalisation existed) and the normalised key.
 */
export function trialEmailKeys(email: string) {
  return Array.from(new Set([legacyTrialEmailKey(email), normalizedTrialEmailKey(email)]));
}

/** True when the address is on a well-known disposable provider. */
export function isDisposableEmailDomain(email: string | null | undefined) {
  if (!email) return false;
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf('@');
  if (at < 0) return false;
  return DISPOSABLE_SET.has(trimmed.slice(at + 1));
}
