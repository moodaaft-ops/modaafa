import { buildExecutableAction } from './executable-action';

// A week is the longest approval window. Execution still re-reads live state.
export const RECOMMENDATION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const EXECUTABLE = new Set(['pause_keyword', 'pause_ad', 'add_keyword', 'add_negative_keyword', 'adjust_budget', 'adjust_bid']);
export type ReviewableRecommendation = {
  action_payload?: any;
  created_at?: string | null;
  title?: string | null;
  description?: string | null;
  expected_impact?: any;
};

export function recommendationReadiness(item: ReviewableRecommendation, customerId?: string | null, now = Date.now()) {
  const operation = String(item.action_payload?.operation ?? '');
  const createdAt = Date.parse(item.created_at ?? '');
  if (!Number.isFinite(createdAt) || createdAt > now || now - createdAt > RECOMMENDATION_MAX_AGE_MS) {
    return { ready: false, code: 'recommendation_stale', message: 'هذه التوصية قديمة أو تاريخها غير موثوق. أعد فحص الحساب للحصول على قرار مبني على بيانات حديثة.' } as const;
  }
  if (!EXECUTABLE.has(operation)) {
    return { ready: false, code: 'manual_review_required', message: 'هذه توصية تشخيصية تحتاج مراجعة يدوية. لا يوجد تعديل تلقائي جاهز للاعتماد.' } as const;
  }
  if (!buildExecutableAction(item.action_payload, item, customerId)) {
    return { ready: false, code: 'recommendation_incomplete', message: 'تفاصيل التعديل غير مكتملة أو لا تطابق الحساب. أعد الفحص قبل الموافقة؛ لن يُرسل هذا المقترح إلى Google Ads.' } as const;
  }
  return { ready: true, code: 'ready', message: 'التعديل مكتمل للمراجعة. نتحقق من الحالة الحية وضوابط الأمان مرة أخرى عند التنفيذ.' } as const;
}
