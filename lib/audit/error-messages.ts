/**
 * Maps every error code the audit endpoint can return to a message that says
 * what happened and what to do next. The same map feeds the progress dialog and
 * the `?error=` banner on the audit page, so both always agree.
 */

export type AuditErrorAction = 'retry' | 'billing' | 'connect';

export type AuditErrorInfo = {
  code: string;
  title: string;
  /** What happened. */
  message: string;
  /** What the user can do now. */
  nextStep: string;
  /** Actions offered next to the always-present close button. */
  actions: AuditErrorAction[];
};

const NO_CHANGE_NOTE = 'لم ننفذ أي تعديل على حسابك في Google Ads.';

const KNOWN: Record<string, Omit<AuditErrorInfo, 'code'>> = {
  subscription_required: {
    title: 'الفحص يحتاج تجربة أو اشتراكاً',
    message: 'حسابك ما عنده تجربة مجانية أو اشتراك فعّال، فما قدرنا نبدأ الفحص.',
    nextStep: 'افتح الفوترة وابدأ التجربة أو اختر خطة، ثم ارجع وشغّل الفحص.',
    actions: ['billing'],
  },
  quota_exceeded: {
    title: 'وصلت إلى حد الفحوصات',
    message: 'استهلكت فحوصات خطتك الحالية لهذه الفترة.',
    nextStep: 'انتظر تجدد الحد أو رقّ خطتك من الفوترة لتشغّل فحصاً الآن.',
    actions: ['billing'],
  },
  usage_storage_unavailable: {
    title: 'تعذر التحقق من حد الاستخدام',
    message: 'ما قدرنا نتأكد من رصيد فحوصاتك الآن، فأوقفنا الفحص لحماية حسابك.',
    nextStep: 'أعد المحاولة بعد دقيقة. إذا تكرر الخطأ تواصل مع الدعم.',
    actions: ['retry'],
  },
  account_not_found: {
    title: 'الحساب الإعلاني غير موجود',
    message: 'ما لقينا الحساب المختار ضمن حساباتك المرتبطة. ممكن يكون الربط انتهى أو الحساب انفصل.',
    nextStep: 'اختر حساباً آخر من القائمة أو جدّد الربط مع Google Ads.',
    actions: ['connect'],
  },
  too_many_requests: {
    title: 'طلبات فحص كثيرة بوقت قصير',
    message: 'أرسلت عدة طلبات فحص متقاربة فأوقفنا الطلب الأخير مؤقتاً.',
    nextStep: 'انتظر دقيقة ثم أعد المحاولة.',
    actions: ['retry'],
  },
  security_service_unavailable: {
    title: 'تعذر التحقق الأمني',
    message: 'خدمة التحقق من أمان الطلب ما ردّت الآن.',
    nextStep: 'أعد المحاولة بعد لحظات.',
    actions: ['retry'],
  },
  service_unavailable: {
    title: 'الخدمة غير متاحة الآن',
    message: 'ما قدرنا نجهز الفحص بسبب عطل مؤقت عندنا.',
    nextStep: 'أعد المحاولة بعد دقائق.',
    actions: ['retry'],
  },
  unauthorized: {
    title: 'انتهت جلستك',
    message: 'سجّل الدخول مرة ثانية لتكمل الفحص.',
    nextStep: 'حدّث الصفحة وسجّل دخولك.',
    actions: [],
  },
  invalid_origin: {
    title: 'تعذر قبول الطلب',
    message: 'الطلب جاء من صفحة غير معروفة فرفضناه.',
    nextStep: 'افتح المنصة من رابطها الرسمي وأعد المحاولة.',
    actions: ['retry'],
  },
  audit_failed: {
    title: 'ما اكتمل الفحص',
    message: 'حصل خطأ أثناء الفحص ولم تُحفظ نتيجة.',
    nextStep: 'أعد المحاولة. إذا تكرر الخطأ جرّب بعد قليل أو تواصل مع الدعم.',
    actions: ['retry'],
  },
};

export function isKnownAuditErrorCode(code: string | null | undefined): boolean {
  return Boolean(code && Object.prototype.hasOwnProperty.call(KNOWN, code));
}

export function auditErrorInfo(code?: string | null, options: { resetsAt?: string | null } = {}): AuditErrorInfo {
  const key = code && isKnownAuditErrorCode(code) ? code : 'audit_failed';
  const base = KNOWN[key];
  let nextStep = base.nextStep;

  if (key === 'quota_exceeded') {
    const when = formatResetDate(options.resetsAt);
    if (when) nextStep = `يتجدد الحد في ${when}. وتقدر ترقّي خطتك من الفوترة وتشغّل الفحص الآن.`;
  }

  return {
    code: key,
    title: base.title,
    message: key === 'audit_failed' || key === 'account_not_found' ? `${base.message} ${NO_CHANGE_NOTE}` : base.message,
    nextStep,
    actions: base.actions,
  };
}

/** Gregorian date with Latin digits, e.g. "8 أكتوبر 2026". Empty string when unparseable. */
export function formatResetDate(value?: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('ar-SA-u-nu-latn-ca-gregory', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Asia/Riyadh',
  }).format(date);
}

/** Single-paragraph form for the `?error=` banner on the audit page. */
export function auditErrorSummary(code?: string | null): string {
  const info = auditErrorInfo(code);
  return `${info.title}. ${info.message} ${info.nextStep}`;
}
