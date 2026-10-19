/**
 * Arabic wording for every way the in-platform checkout can fail.
 *
 * The raw `message` Stripe returns is English and often names the card or the
 * bank's reasoning, so it is never shown. Everything the customer reads comes
 * from here, keyed on Stripe's `code` and `decline_code` (and on our own codes
 * for the gates that run before Stripe is called).
 *
 * This file imports nothing, so the browser bundle and the API routes share it.
 * Wording rules: short, Gulf Arabic, Arabic comma, no dashes, and every message
 * says whether money moved.
 */

/** What the customer should do next. The page picks the button from this. */
export type CheckoutErrorAction =
  | 'edit_card' // change the card details and try again
  | 'retry' // same details, try again in a moment
  | 'refresh' // reload the page, the terms changed
  | 'continue' // nothing to fix here, go on to the platform
  | 'contact'; // we need to look at it

export type CheckoutErrorInput = {
  code?: string | null;
  decline_code?: string | null;
  type?: string | null;
};

export type CheckoutErrorView = {
  /** Machine code kept for logs and tests. */
  code: string;
  message: string;
  action: CheckoutErrorAction;
};

export const NOTHING_CHARGED = 'ما انخصم شي.';

const DECLINE_MESSAGES: Record<string, string> = {
  insufficient_funds: `رصيد البطاقة ما يكفي. ${NOTHING_CHARGED} اشحن الرصيد أو جرّب بطاقة ثانية.`,
  // These tell the bank's story, not ours. The customer is not told the card was
  // reported lost or stolen, only that the bank refused it.
  lost_card: `البنك رفض هالبطاقة. ${NOTHING_CHARGED} جرّب بطاقة ثانية أو كلّم البنك.`,
  stolen_card: `البنك رفض هالبطاقة. ${NOTHING_CHARGED} جرّب بطاقة ثانية أو كلّم البنك.`,
  pickup_card: `البنك رفض هالبطاقة. ${NOTHING_CHARGED} جرّب بطاقة ثانية أو كلّم البنك.`,
  fraudulent: `البنك رفض هالبطاقة. ${NOTHING_CHARGED} جرّب بطاقة ثانية أو كلّم البنك.`,
  restricted_card: `البنك رفض هالبطاقة. ${NOTHING_CHARGED} جرّب بطاقة ثانية أو كلّم البنك.`,
  expired_card: `البطاقة منتهية. ${NOTHING_CHARGED} استخدم بطاقة سارية.`,
  incorrect_cvc: `رمز الأمان CVC غير صحيح. ${NOTHING_CHARGED}`,
  invalid_cvc: `رمز الأمان CVC غير صحيح. ${NOTHING_CHARGED}`,
  incorrect_number: `رقم البطاقة غير صحيح. ${NOTHING_CHARGED}`,
  invalid_number: `رقم البطاقة غير صحيح. ${NOTHING_CHARGED}`,
  invalid_expiry_month: `تاريخ انتهاء البطاقة غير صحيح. ${NOTHING_CHARGED}`,
  invalid_expiry_year: `تاريخ انتهاء البطاقة غير صحيح. ${NOTHING_CHARGED}`,
  card_velocity_exceeded: `البطاقة وصلت حد العمليات عند البنك. ${NOTHING_CHARGED} جرّب بعد شوي أو بطاقة ثانية.`,
  withdrawal_count_limit_exceeded: `البطاقة وصلت حد العمليات عند البنك. ${NOTHING_CHARGED} جرّب بعد شوي أو بطاقة ثانية.`,
  card_not_supported: `البطاقة ما تدعم هالنوع من الاشتراكات. ${NOTHING_CHARGED} جرّب بطاقة ثانية.`,
  currency_not_supported: `البطاقة ما تدعم الدفع بالريال. ${NOTHING_CHARGED} جرّب بطاقة ثانية.`,
  authentication_required: authenticationFailed(),
  do_not_honor: bankRefused(),
  generic_decline: bankRefused(),
  call_issuer: bankRefused(),
  do_not_try_again: bankRefused(),
  not_permitted: bankRefused(),
  transaction_not_allowed: bankRefused(),
  try_again_later: `البنك ما قدر يكمل العملية الحين. ${NOTHING_CHARGED} جرّب بعد دقيقة.`,
  issuer_not_available: `البنك ما قدر يكمل العملية الحين. ${NOTHING_CHARGED} جرّب بعد دقيقة.`,
  processing_error: processingError(),
};

function bankRefused() {
  return `البنك رفض العملية ولم يذكر السبب. ${NOTHING_CHARGED} كلّم البنك أو جرّب بطاقة ثانية.`;
}

function authenticationFailed() {
  return `ما تمّ التحقق من البطاقة عند البنك (3D Secure). ${NOTHING_CHARGED} جرّب مرة ثانية أو بطاقة ثانية.`;
}

function processingError() {
  return `صار خطأ عند معالجة البطاقة. ${NOTHING_CHARGED} جرّب بعد شوي.`;
}

function networkError() {
  return `تعذّر الاتصال. تأكد من الإنترنت وحاول مرة ثانية. ${NOTHING_CHARGED}`;
}

const ACTION_BY_CODE: Record<string, CheckoutErrorAction> = {
  card_declined: 'edit_card',
  expired_card: 'edit_card',
  incorrect_cvc: 'edit_card',
  invalid_cvc: 'edit_card',
  incorrect_number: 'edit_card',
  invalid_number: 'edit_card',
  invalid_expiry_month: 'edit_card',
  invalid_expiry_year: 'edit_card',
  incomplete_number: 'edit_card',
  incomplete_cvc: 'edit_card',
  incomplete_expiry: 'edit_card',
  incomplete_zip: 'edit_card',
  invalid_expiry_month_past: 'edit_card',
  invalid_expiry_year_past: 'edit_card',
  payment_intent_authentication_failure: 'edit_card',
  setup_intent_authentication_failure: 'edit_card',
  authentication_required: 'edit_card',
  card_trial_used: 'continue',
  ads_account_trial_used: 'continue',
  already_subscribed: 'continue',
  terms_changed: 'refresh',
  processing_error: 'retry',
  api_connection_error: 'retry',
  network_error: 'retry',
  rate_limit: 'retry',
  too_many_requests: 'retry',
  trial_check_failed: 'retry',
  checkout_failed: 'retry',
  security_service_unavailable: 'retry',
  setup_not_completed: 'retry',
  payment_processing: 'continue',
  promo_invalid: 'edit_card',
  promo_expired: 'edit_card',
  promo_not_applicable: 'edit_card',
};

/** Messages for codes that are not card errors. */
const GENERAL_MESSAGES: Record<string, string> = {
  incomplete_number: `رقم البطاقة ناقص. ${NOTHING_CHARGED}`,
  incomplete_cvc: `رمز الأمان CVC ناقص. ${NOTHING_CHARGED}`,
  incomplete_expiry: `تاريخ انتهاء البطاقة ناقص. ${NOTHING_CHARGED}`,
  incomplete_zip: `الرمز البريدي ناقص. ${NOTHING_CHARGED}`,
  invalid_expiry_month_past: `البطاقة منتهية. ${NOTHING_CHARGED} استخدم بطاقة سارية.`,
  invalid_expiry_year_past: `البطاقة منتهية. ${NOTHING_CHARGED} استخدم بطاقة سارية.`,
  payment_intent_authentication_failure: authenticationFailed(),
  setup_intent_authentication_failure: authenticationFailed(),
  authentication_required: authenticationFailed(),
  processing_error: processingError(),
  api_connection_error: networkError(),
  network_error: networkError(),
  rate_limit: `الطلبات كثيرة الحين. ${NOTHING_CHARGED} جرّب بعد دقيقة.`,
  too_many_requests: `حاولت أكثر من مرة بوقت قصير. ${NOTHING_CHARGED} جرّب بعد شوي.`,
  security_service_unavailable: `ما قدرنا نتحقق من أمان العملية الحين. ${NOTHING_CHARGED} جرّب بعد دقيقة.`,
  unauthorized: 'انتهت جلستك. سجّل دخولك من جديد وكمّل.',
  invalid_origin: `ما قدرنا نتحقق من مصدر الطلب. ${NOTHING_CHARGED} حدّث الصفحة وجرّب.`,
  invalid_plan: `الخطة غير صالحة. ${NOTHING_CHARGED} ارجع واختر الخطة من جديد.`,
  invalid_period: `مدة الاشتراك غير صالحة. ${NOTHING_CHARGED} ارجع واختر من جديد.`,
  already_subscribed: 'عندك اشتراك قائم، تقدر تكمل على المنصة مباشرة.',
  google_ads_account_required: 'اربط حساب Google Ads نشطاً أولاً، وبعدها تبدأ.',
  account_suspended: 'الحساب موقوف مؤقتاً. تواصل معنا ونرجعه لك.',
  internal_access: 'حساب الفريق ما يحتاج اشتراك.',
  card_trial_used: 'هالبطاقة استخدمت التجربة المجانية قبل، تقدر تشترك مباشرة. ما انخصم شي.',
  ads_account_trial_used:
    'حسابات الإعلانات المربوطة أخذت تجربتها المجانية قبل، فما فعّلنا لك تجربة وما انخصم شي. تقدر تشترك وتربطها مباشرة.',
  trial_check_failed: 'صار خلل مؤقت في التحقق من التجربة، جرّب بعد دقيقة. ما انخصم شي.',
  terms_changed: `تغيّرت حالة التجربة بين فتح الصفحة والدفع. ${NOTHING_CHARGED} حدّث الصفحة وراجع التفاصيل.`,
  promo_invalid: 'كود الخصم غير صحيح. تأكد منه أو أكمل بدونه.',
  promo_expired: 'كود الخصم منتهي. أكمل بدونه أو جرّب كود ثاني.',
  promo_not_applicable: 'كود الخصم ما ينطبق على هالخطة. أكمل بدونه أو جرّب كود ثاني.',
  setup_not_completed: `ما اكتمل حفظ البطاقة. ${NOTHING_CHARGED} حاول من جديد.`,
  payment_processing: 'العملية قيد المعالجة عند البنك. لا تعيد الدفع، وراح نفعّل اشتراكك أول ما تكتمل.',
  subscription_conflict: 'عندك اشتراك ثاني قائم. وصلنا تنبيه وراح نراجعه معك. لا تعيد الدفع.',
  checkout_failed: `ما قدرنا نكمل الدفع. ${NOTHING_CHARGED} جرّب مرة ثانية.`,
  activation_failed: 'تم الدفع بس ما قدرنا نفعّل الاشتراك على المنصة. لا تعيد الدفع، تواصل معنا ونفعّله لك.',
};

const FALLBACK = GENERAL_MESSAGES.checkout_failed;

/** True when the thrown value looks like the browser failing to reach the network. */
export function isNetworkFailure(error: unknown) {
  if (error instanceof TypeError) return true;
  const text = error instanceof Error ? error.message : String(error ?? '');
  return /failed to fetch|networkerror|load failed|network request failed/i.test(text);
}

/**
 * The view for a Stripe error or one of our own codes. Unknown codes fall back
 * to a generic Arabic line; the raw English text is never returned.
 */
export function arabicCheckoutError(input: CheckoutErrorInput | string | null | undefined): CheckoutErrorView {
  const normalized: CheckoutErrorInput = typeof input === 'string' ? { code: input } : input ?? {};
  const code = normalized.code ?? 'checkout_failed';
  const decline = normalized.decline_code ?? null;

  // A decline carries the specific reason in decline_code.
  if (code === 'card_declined') {
    const message = (decline && DECLINE_MESSAGES[decline]) || bankRefused();
    return { code: decline ? `card_declined:${decline}` : code, message, action: 'edit_card' };
  }

  const message = DECLINE_MESSAGES[code] ?? GENERAL_MESSAGES[code] ?? FALLBACK;
  const known = code in DECLINE_MESSAGES || code in GENERAL_MESSAGES;
  return {
    code: known ? code : 'checkout_failed',
    message,
    action: ACTION_BY_CODE[code] ?? (known ? 'contact' : 'retry'),
  };
}
