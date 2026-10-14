import { EMAIL_CATEGORIES, OPTIONAL_CATEGORIES, type EmailCategory, type OptionalCategory } from '@/lib/lifecycle/types';
import { appBaseUrl, signValue, verifySignedValue } from './opt-out';

/**
 * Email preferences.
 *
 * users.email_prefs is a jsonb object keyed by category with boolean values.
 * A missing key means "on". users.messages_opt_out = true (the one-click stop
 * from PR #81) means every optional category is off. `transactional` cannot be
 * switched off by anything here.
 */
export type EmailPrefs = Partial<Record<EmailCategory, boolean>>;

const PREFS_PREFIX = 'email_prefs';
const USER_ID = /^[0-9a-f-]{36}$/i;

/** Keeps only known categories with real booleans; anything else in the jsonb is ignored. */
export function normalizePrefs(raw: unknown): EmailPrefs {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: EmailPrefs = {};
  for (const category of EMAIL_CATEGORIES) {
    const value = (raw as Record<string, unknown>)[category];
    if (typeof value === 'boolean') out[category] = value;
  }
  return out;
}

export function isCategoryOn(
  prefs: EmailPrefs | null | undefined,
  optOutFlag: boolean | null | undefined,
  category: EmailCategory
): boolean {
  if (category === 'transactional') return true;
  if (optOutFlag) return false;
  return normalizePrefs(prefs)[category] !== false;
}

/** The three optional categories as the preferences page shows them. */
export function optionalState(prefs: EmailPrefs | null | undefined, optOutFlag: boolean | null | undefined) {
  return Object.fromEntries(OPTIONAL_CATEGORIES.map((c) => [c, isCategoryOn(prefs, optOutFlag, c)])) as Record<
    OptionalCategory,
    boolean
  >;
}

/** Signed link to /email-preferences for this user. Null when no signing key is configured. */
export function buildPreferencesUrl(userId: string): string | null {
  if (!USER_ID.test(userId)) return null;
  const token = signValue(PREFS_PREFIX, userId);
  if (!token) return null;
  const params = new URLSearchParams({ u: userId, t: token });
  return `${appBaseUrl()}/email-preferences?${params.toString()}`;
}

export function verifyPreferencesToken(userId: string | null | undefined, token: string | null | undefined): boolean {
  if (!userId || !token || !USER_ID.test(userId)) return false;
  return verifySignedValue(PREFS_PREFIX, userId, token);
}

export type PrefsRow = {
  email: string | null;
  email_prefs: EmailPrefs;
  messages_opt_out: boolean;
  email_suppressed_at: string | null;
};

/** One read of everything the preferences page and the send guard need. */
export async function loadPrefsRow(
  admin: any,
  userId: string
): Promise<{ ok: true; row: PrefsRow } | { ok: false; reason: 'lookup_failed' | 'user_not_found' }> {
  const { data, error } = await admin
    .from('users')
    .select('email, email_prefs, messages_opt_out, email_suppressed_at')
    .eq('id', userId)
    .maybeSingle();
  if (error) return { ok: false, reason: 'lookup_failed' };
  if (!data) return { ok: false, reason: 'user_not_found' };
  return {
    ok: true,
    row: {
      email: typeof data.email === 'string' ? data.email : null,
      email_prefs: normalizePrefs(data.email_prefs),
      messages_opt_out: data.messages_opt_out === true,
      email_suppressed_at: data.email_suppressed_at ?? null,
    },
  };
}

export type PrefsUpdate =
  | { stopAll: true }
  | { stopAll?: false; choices: Partial<Record<OptionalCategory, boolean>> };

/**
 * Saves the user's choice.
 *   stopAll        every optional category off and messages_opt_out = true, exactly
 *                  what the one-click link in the email footer does.
 *   choices        the three checkboxes. All three keys are written, so an
 *                  unchecked box is an explicit off. If any box is on, the
 *                  one-click flag is cleared (the person opted back in).
 * Other keys in the jsonb (onboarding) are kept as they were.
 */
export async function updatePrefs(
  admin: any,
  userId: string,
  update: PrefsUpdate,
  now: Date = new Date()
): Promise<{ ok: true; prefs: EmailPrefs; messagesOptOut: boolean } | { ok: false; reason: string }> {
  const current = await loadPrefsRow(admin, userId);
  if (!current.ok) return { ok: false, reason: current.reason };

  const next: EmailPrefs = { ...current.row.email_prefs };
  let messagesOptOut = current.row.messages_opt_out;
  const patch: Record<string, unknown> = {};

  if (update.stopAll) {
    for (const category of OPTIONAL_CATEGORIES) next[category] = false;
    if (!messagesOptOut) {
      messagesOptOut = true;
      patch.messages_opt_out = true;
      patch.messages_opt_out_at = now.toISOString();
    }
  } else {
    for (const category of OPTIONAL_CATEGORIES) next[category] = update.choices[category] === true;
    const anyOn = OPTIONAL_CATEGORIES.some((category) => next[category] === true);
    if (anyOn && messagesOptOut) {
      messagesOptOut = false;
      patch.messages_opt_out = false;
    }
  }

  patch.email_prefs = next;
  const { error } = await admin.from('users').update(patch).eq('id', userId);
  if (error) return { ok: false, reason: 'update_failed' };
  return { ok: true, prefs: next, messagesOptOut };
}

/**
 * Complaint handling: every optional category off, the rest of the jsonb kept.
 * Does not touch messages_opt_out (suppression already stops everything).
 */
export function allOptionalOff(current: EmailPrefs): EmailPrefs {
  const next: EmailPrefs = { ...current };
  for (const category of OPTIONAL_CATEGORIES) next[category] = false;
  return next;
}
