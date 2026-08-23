export const AUDIT_PROGRESS_STEPS = [
  {
    id: 'prepare',
    title: 'تجهيز الفحص',
    runningLabel: 'نتحقق من الحساب والصلاحية وحدود الاستخدام',
    completedLabel: 'تم التحقق من الحساب وبدء الفحص بأمان',
    startPercent: 2,
    completePercent: 8,
  },
  {
    id: 'sync',
    title: 'تحديث الحملات',
    runningLabel: 'نسحب أحدث الحملات ونتائجها من Google Ads',
    completedLabel: 'تم تحديث بيانات الحملات المتاحة',
    startPercent: 10,
    completePercent: 30,
  },
  {
    id: 'live_data',
    title: 'جمع أدلة Google Ads',
    runningLabel: 'نفحص الكلمات وعبارات البحث والإعلانات والتحويلات',
    completedLabel: 'تم جمع طبقات الأدلة الحية المتاحة',
    startPercent: 32,
    completePercent: 58,
  },
  {
    id: 'account_context',
    title: 'تجهيز سياق الحساب',
    runningLabel: 'نقرأ البيانات المحفوظة ونقارنها بسياق النشاط والقطاع',
    completedLabel: 'اكتمل تجهيز سياق الحساب للمقارنة',
    startPercent: 60,
    completePercent: 68,
  },
  {
    id: 'analysis',
    title: 'تحليل الأداء والمخاطر',
    runningLabel: 'نحلل الهدر وجودة البيانات وفرص التحسين',
    completedLabel: 'اكتمل التحليل القائم على الأدلة',
    startPercent: 70,
    completePercent: 80,
  },
  {
    id: 'ai_narrative',
    title: 'صياغة القراءة الذكية',
    runningLabel: 'نرتب الأولويات ونشرح النتائج بلغة عملية',
    completedLabel: 'اكتملت القراءة الذكية للنتائج',
    startPercent: 82,
    completePercent: 92,
  },
  {
    id: 'save',
    title: 'حفظ التقرير والتوصيات',
    runningLabel: 'نحفظ التقرير ونجهز التوصيات لمراجعتك',
    completedLabel: 'تم حفظ التقرير والتوصيات بنجاح',
    startPercent: 94,
    completePercent: 100,
  },
] as const;

export type AuditProgressStepId = (typeof AUDIT_PROGRESS_STEPS)[number]['id'];
export type AuditProgressPhase = 'started' | 'completed';

export type AuditProgressEvent = {
  type: 'progress';
  step: AuditProgressStepId;
  phase: AuditProgressPhase;
  percent: number;
  message: string;
  detail?: string;
  warning?: boolean;
};

export type AuditCompleteEvent = {
  type: 'complete';
  percent: 100;
  message: string;
  redirect: string;
};

export type AuditErrorEvent = {
  type: 'error';
  code: string;
  message: string;
};

export type AuditStreamEvent = AuditProgressEvent | AuditCompleteEvent | AuditErrorEvent;

export function auditProgressEvent(
  step: AuditProgressStepId,
  phase: AuditProgressPhase,
  options: { detail?: string; warning?: boolean } = {}
): AuditProgressEvent {
  const definition = AUDIT_PROGRESS_STEPS.find((item) => item.id === step);
  if (!definition) throw new Error(`Unknown audit progress step: ${step}`);

  return {
    type: 'progress',
    step,
    phase,
    percent: phase === 'started' ? definition.startPercent : definition.completePercent,
    message: phase === 'started' ? definition.runningLabel : definition.completedLabel,
    ...options,
  };
}
