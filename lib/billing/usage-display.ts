import {
  PLAN_LIMITS,
  featureAccessMessage,
  usageWindow,
  type BillingPlan,
  type FeatureAccessResult,
  type MeteredFeature,
} from '@/lib/billing/entitlements';
import { arabicCount, type ArabicNounForms } from '@/lib/ui/plural';

/**
 * Display helpers for plan limits. Every number and period here is read from
 * PLAN_LIMITS, the same table `consumeFeatureUsage` enforces, so the pricing
 * cards, the usage meters and the limit-reached message cannot drift from
 * what the server actually allows. Display only: nothing here grants access.
 */

type Period = 'day' | 'week' | 'month';

type FeatureDisplay = {
  /** Name of the limit, as the customer sees it. */
  label: string;
  /** What one use is called: "3 رسائل", "5 تحديثات". */
  unit: ArabicNounForms;
};

export const FEATURE_ORDER: readonly MeteredFeature[] = [
  'assistant',
  'audit',
  'manual_sync',
  'execute_action',
  'campaign_builder',
];

const FEATURE_DISPLAY: Record<MeteredFeature, FeatureDisplay> = {
  assistant: {
    label: 'رسائل المساعد',
    unit: { one: 'رسالة واحدة', two: 'رسالتان', few: 'رسائل', many: 'رسالة' },
  },
  audit: {
    label: 'فحص الحساب',
    unit: { one: 'فحص واحد', two: 'فحصان', few: 'فحوصات', many: 'فحصاً', other: 'فحص' },
  },
  manual_sync: {
    label: 'تحديث البيانات',
    unit: { one: 'تحديث واحد', two: 'تحديثان', few: 'تحديثات', many: 'تحديثاً', other: 'تحديث' },
  },
  execute_action: {
    label: 'تنفيذ التوصيات',
    unit: { one: 'عملية واحدة', two: 'عمليتان', few: 'عمليات', many: 'عملية' },
  },
  campaign_builder: {
    label: 'باني الحملات',
    unit: { one: 'طلب واحد', two: 'طلبان', few: 'طلبات', many: 'طلباً', other: 'طلب' },
  },
};

const PERIOD_ADVERB: Record<Period, string> = {
  day: 'يومياً',
  week: 'أسبوعياً',
  month: 'شهرياً',
};

const PERIOD_NOUN: Record<Period, string> = {
  day: 'اليوم',
  week: 'الأسبوع',
  month: 'الشهر',
};

export function featureLabel(feature: MeteredFeature) {
  return FEATURE_DISPLAY[feature].label;
}

export function featurePeriod(feature: MeteredFeature): Period {
  return PLAN_LIMITS.starter[feature].period;
}

/** "20 رسالة يومياً" for a plan card. */
export function describePlanLimit(plan: BillingPlan, feature: MeteredFeature) {
  const { limit, period } = PLAN_LIMITS[plan][feature];
  return `${arabicCount(limit, FEATURE_DISPLAY[feature].unit)} ${PERIOD_ADVERB[period]}`;
}

/** One line per enforced limit, for the plan cards. */
export function planFeatureLines(plan: BillingPlan) {
  return FEATURE_ORDER.map((feature) => `${featureLabel(feature)}: ${describePlanLimit(plan, feature)}`);
}

const resetFormat = new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', {
  timeZone: 'Asia/Riyadh',
  day: 'numeric',
  month: 'long',
  hour: 'numeric',
  minute: '2-digit',
});

/** When the window that contains `now` closes, as shown to the customer. */
export function formatResetAr(resetsAt: Date | string) {
  const date = typeof resetsAt === 'string' ? new Date(resetsAt) : resetsAt;
  if (Number.isNaN(date.getTime())) return null;
  return `${resetFormat.format(date)} بتوقيت الرياض`;
}

export function resetDateFor(feature: MeteredFeature, now = new Date()) {
  return usageWindow(featurePeriod(feature), now).end;
}

/**
 * The limit-reached message: which limit, how large it is on the customer's
 * plan when known, and when it comes back. Both facts come from the enforced
 * table and window, never from the caller's guess.
 */
export function quotaExceededMessage({
  feature,
  plan,
  resetsAt,
  now = new Date(),
}: {
  feature: MeteredFeature;
  plan?: BillingPlan | null;
  resetsAt?: Date | string | null;
  now?: Date;
}) {
  const period = featurePeriod(feature);
  const limitText = plan ? ` (${describePlanLimit(plan, feature)})` : '';
  const reset = formatResetAr(resetsAt ?? resetDateFor(feature, now));
  const resetText = reset ? `يتجدد الحد ${reset}.` : `يتجدد الحد مع بداية ${PERIOD_NOUN[period]} التالي.`;
  return `وصلت إلى حد ${featureLabel(feature)} في خطتك${limitText}. ${resetText} يمكنك الترقية من صفحة الفوترة.`;
}

/** Message for a refused `consumeFeatureUsage` call, naming the limit when it was the quota. */
export function usageDeniedMessage(
  result: Extract<FeatureAccessResult, { ok: false }>,
  feature: MeteredFeature
) {
  if (result.reason === 'quota_exceeded') {
    return quotaExceededMessage({ feature, plan: result.plan, resetsAt: result.resetsAt });
  }
  return featureAccessMessage(result.reason);
}

export type UsageMeter = {
  feature: MeteredFeature;
  label: string;
  used: number;
  limit: number;
  period: Period;
  periodLabel: string;
  resetsAt: Date;
  percent: number;
  tone: 'ok' | 'near' | 'full';
};

export function buildUsageMeter(
  feature: MeteredFeature,
  plan: BillingPlan,
  used: number,
  now = new Date()
): UsageMeter {
  const { limit, period } = PLAN_LIMITS[plan][feature];
  const safeUsed = Math.max(0, Math.floor(used));
  const percent = Math.min(100, Math.round((safeUsed / limit) * 100));
  return {
    feature,
    label: featureLabel(feature),
    used: safeUsed,
    limit,
    period,
    periodLabel: PERIOD_ADVERB[period],
    resetsAt: usageWindow(period, now).end,
    percent,
    tone: safeUsed >= limit ? 'full' : percent >= 80 ? 'near' : 'ok',
  };
}

/**
 * Current usage per feature, counted the way `consume_feature_usage` counts:
 * rows for this user and feature inside the enforced window. A failed count
 * comes back as null so the page can say it could not read usage instead of
 * showing a false zero.
 */
export async function loadUsageMeters(
  supabase: any,
  userId: string,
  plan: BillingPlan,
  now = new Date()
): Promise<UsageMeter[] | null> {
  const counts = await Promise.all(
    FEATURE_ORDER.map(async (feature) => {
      const { period } = PLAN_LIMITS[plan][feature];
      const { start, end } = usageWindow(period, now);
      const { count, error } = await supabase
        .from('usage_events')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('feature', feature)
        .gte('created_at', start.toISOString())
        .lt('created_at', end.toISOString());
      if (error) {
        console.error('Failed to read usage for billing meter', { feature, error });
        return null;
      }
      return count ?? 0;
    })
  );
  if (counts.some((value) => value === null)) return null;
  return FEATURE_ORDER.map((feature, index) => buildUsageMeter(feature, plan, counts[index] as number, now));
}

/**
 * Length of the free trial shown to customers. Display only: the checkout
 * routes pass the same 14 to Stripe (`trialDays: billing.trialEligible ? 14 : 0`),
 * and tests/billing-usage-display.test.ts fails if the two ever differ.
 */
export const TRIAL_DAYS = 14;

/** Whole days left until `endsAt`, never negative. A started day counts as a day. */
export function trialDaysLeft(endsAt: string | Date | null | undefined, now = new Date()) {
  if (!endsAt) return null;
  const end = typeof endsAt === 'string' ? new Date(endsAt) : endsAt;
  if (Number.isNaN(end.getTime())) return null;
  return Math.max(0, Math.ceil((end.getTime() - now.getTime()) / 86_400_000));
}
