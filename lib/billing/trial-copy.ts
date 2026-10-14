import type { TrialIneligibleReason } from '@/lib/billing/checkout-policy';

/**
 * Customer-facing wording for the trial guards. One module so the billing page,
 * the onboarding trial page and the tests read the same strings. Short, Gulf
 * Arabic, Arabic comma, no dashes.
 */

/** `/billing?error=card_trial_used` and `/onboarding/trial?error=card_trial_used`. */
export const CARD_TRIAL_USED_MESSAGE = 'هالبطاقة استخدمت التجربة المجانية قبل، تقدر تشترك مباشرة.';

/**
 * `/billing?error=ads_account_trial_used` and `/onboarding/trial?error=ads_account_trial_used`:
 * the trial was cancelled at its start because every linked Google Ads account had
 * already taken its trial under another user. Nothing was charged.
 */
export const ADS_ACCOUNT_TRIAL_USED_MESSAGE =
  'حسابات الإعلانات المربوطة أخذت تجربتها المجانية قبل، فما فعّلنا لك تجربة وما انخصم شي. تقدر تشترك وتربطها مباشرة.';

/** `/billing?error=trial_check_failed`: the eligibility check could not run, so nothing was charged or started. */
export const TRIAL_CHECK_FAILED_MESSAGE = 'صار خلل مؤقت في التحقق من التجربة، جرّب بعد دقيقة.';

/** Shown wherever a trial is offered: the trial runs on Starter limits (effectiveLimitPlan). */
export const TRIAL_STARTER_LIMITS_NOTE = 'خلال التجربة تشتغل بحدود باقة البداية، والحدود الكاملة تبدأ من أول دفعة.';

/**
 * The line under the title of the trial page: what is free (the first audit)
 * and what opens with the plan (every decision). It must agree with the
 * paywall, where only the first decision is open, so it never says that reading
 * the recommendations is free. «تجربتك» when a trial is on offer, «اشتراكك» when it is not.
 */
export function trialPageIntro(trialEligible: boolean): string {
  return `الفحص الأول مجاني، والقرارات كلها تنفتح مع ${trialEligible ? 'تجربتك' : 'اشتراكك'}.`;
}

const ADS_ACCOUNT_USED_NOTICE = 'حساب الإعلانات هذا أخذ تجربته المجانية قبل، فالاشتراك يبدأ مباشرة.';
const DISPOSABLE_EMAIL_NOTICE = 'التجربة المجانية تحتاج إيميل دائم، تقدر تشترك مباشرة.';

/**
 * Why this user is not offered a trial, for the reasons that need explaining
 * (`check_failed` is a temporary fault, the rest are facts about the user).
 * `already_used` keeps the pages' existing wording, and null means the trial is
 * on offer.
 */
export function trialIneligibleNotice(reason: TrialIneligibleReason | null | undefined): string | null {
  if (reason === 'ads_account_used') return ADS_ACCOUNT_USED_NOTICE;
  if (reason === 'disposable_email') return DISPOSABLE_EMAIL_NOTICE;
  if (reason === 'check_failed') return TRIAL_CHECK_FAILED_MESSAGE;
  return null;
}
