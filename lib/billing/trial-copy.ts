import type { TrialIneligibleReason } from '@/lib/billing/checkout-policy';

/**
 * Customer-facing wording for the trial guards. One module so the billing page,
 * the onboarding trial page and the tests read the same strings. Short, Gulf
 * Arabic, Arabic comma, no dashes.
 */

/** `/billing?error=card_trial_used` and `/onboarding/trial?error=card_trial_used`. */
export const CARD_TRIAL_USED_MESSAGE = 'هالبطاقة استخدمت التجربة المجانية قبل، تقدر تشترك مباشرة.';

/** Shown wherever a trial is offered: the trial runs on Starter limits (effectiveLimitPlan). */
export const TRIAL_STARTER_LIMITS_NOTE = 'خلال التجربة تشتغل بحدود باقة البداية، والحدود الكاملة تبدأ من أول دفعة.';

const ADS_ACCOUNT_USED_NOTICE = 'حساب الإعلانات هذا أخذ تجربته المجانية قبل، فالاشتراك يبدأ مباشرة.';
const DISPOSABLE_EMAIL_NOTICE = 'التجربة المجانية تحتاج إيميل دائم، تقدر تشترك مباشرة.';

/**
 * Why this user is offered a paid start instead of a trial, for the two reasons
 * that need explaining. `already_used` keeps the pages' existing wording, and
 * null means the trial is on offer.
 */
export function trialIneligibleNotice(reason: TrialIneligibleReason | null | undefined): string | null {
  if (reason === 'ads_account_used') return ADS_ACCOUNT_USED_NOTICE;
  if (reason === 'disposable_email') return DISPOSABLE_EMAIL_NOTICE;
  return null;
}
