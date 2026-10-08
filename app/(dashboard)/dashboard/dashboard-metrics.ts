import { moneyMetric } from '@/lib/google-ads/metrics';
import type { DateRangeSelection } from '@/lib/analytics/date-range';

/**
 * Pure helpers behind the dashboard numbers. Kept free of React and Supabase
 * so the spend total and the goal-dependent KPI choice can be unit tested.
 */

export type MetricsBag = Record<string, unknown> | null | undefined;
export type CampaignLike = { range_metrics?: MetricsBag };

export type Totals = {
  cost: number;
  clicks: number;
  impressions: number;
  conversions: number;
  conversionValue: number;
};

function num(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function totalsFromMetrics(metrics: MetricsBag): Totals {
  return {
    cost: moneyMetric(metrics, 'cost'),
    clicks: num(metrics?.clicks),
    impressions: num(metrics?.impressions),
    conversions: num(metrics?.conversions),
    conversionValue: moneyMetric(metrics, 'conversion_value'),
  };
}

/**
 * Sums every campaign that has numbers in the period, whatever its status.
 * A campaign paused today still spent money earlier in the range, and Google
 * Ads counts that spend in its own total, so filtering to ENABLED only made
 * the dashboard disagree with the account it mirrors.
 */
export function sumCampaignTotals(campaigns: CampaignLike[]): Totals {
  return campaigns.reduce<Totals>(
    (sum, campaign) => {
      const t = totalsFromMetrics(campaign.range_metrics);
      return {
        cost: sum.cost + t.cost,
        clicks: sum.clicks + t.clicks,
        impressions: sum.impressions + t.impressions,
        conversions: sum.conversions + t.conversions,
        conversionValue: sum.conversionValue + t.conversionValue,
      };
    },
    { cost: 0, clicks: 0, impressions: 0, conversions: 0, conversionValue: 0 }
  );
}

/** The period of the same length that ends the day before `range` starts. */
export function previousRange(range: DateRangeSelection): DateRangeSelection {
  const start = Date.parse(`${range.from}T00:00:00.000Z`);
  const to = new Date(start - 86_400_000);
  const from = new Date(to.getTime() - (range.days - 1) * 86_400_000);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return {
    key: 'custom',
    from: iso(from),
    to: iso(to),
    days: range.days,
    label: 'الفترة السابقة',
    metricKey: null,
    error: null,
  };
}

export type SpendChange =
  | { kind: 'unavailable' }
  | { kind: 'none' }
  | { kind: 'new' }
  | { kind: 'delta'; direction: 'up' | 'down' | 'flat'; percent: number; previous: number };

/** `previous` is null when the previous period could not be loaded. */
export function spendChange(current: number, previous: number | null): SpendChange {
  if (previous === null || !Number.isFinite(previous)) return { kind: 'unavailable' };
  if (previous <= 0) return current > 0 ? { kind: 'new' } : { kind: 'none' };
  const percent = ((current - previous) / previous) * 100;
  const rounded = Math.round(Math.abs(percent) * 10) / 10;
  if (rounded === 0) return { kind: 'delta', direction: 'flat', percent: 0, previous };
  return { kind: 'delta', direction: percent > 0 ? 'up' : 'down', percent: rounded, previous };
}

export type BusinessGoal = 'conversions' | 'leads' | 'traffic' | 'awareness';
export type KpiKey =
  | 'conversions'
  | 'leads'
  | 'roas'
  | 'cpa'
  | 'cpl'
  | 'conversion_rate'
  | 'clicks'
  | 'cpc'
  | 'ctr'
  | 'impressions'
  | 'cpm';

export function normalizeGoal(value: unknown): BusinessGoal {
  return value === 'leads' || value === 'traffic' || value === 'awareness' ? value : 'conversions';
}

/** Three KPIs per business goal. A lead goal swaps return on spend for cost per lead. */
export function kpiKeysForGoal(goal: unknown): [KpiKey, KpiKey, KpiKey] {
  switch (normalizeGoal(goal)) {
    case 'leads':
      return ['leads', 'cpl', 'conversion_rate'];
    case 'traffic':
      return ['clicks', 'cpc', 'ctr'];
    case 'awareness':
      return ['impressions', 'cpm', 'ctr'];
    default:
      return ['conversions', 'roas', 'cpa'];
  }
}

export const KPI_LABELS: Record<KpiKey, string> = {
  conversions: 'التحويلات',
  leads: 'العملاء المحتملون',
  roas: 'العائد على الإنفاق',
  cpa: 'تكلفة التحويل',
  cpl: 'تكلفة العميل المحتمل',
  conversion_rate: 'نسبة التحويل',
  clicks: 'النقرات',
  cpc: 'تكلفة النقرة',
  ctr: 'نسبة النقر',
  impressions: 'مرات الظهور',
  cpm: 'تكلفة الألف ظهور',
};

export type KpiValue =
  | { kind: 'count'; value: number }
  | { kind: 'money'; value: number }
  | { kind: 'ratio'; value: number }
  | { kind: 'percent'; value: number }
  | { kind: 'empty'; reason: string };

const NO_CONVERSIONS = 'لا توجد تحويلات في هذه الفترة';
const NO_SPEND = 'لا يوجد إنفاق في هذه الفترة';
const NO_CLICKS = 'لا توجد نقرات في هذه الفترة';
const NO_IMPRESSIONS = 'لا توجد ظهورات في هذه الفترة';

/** Returns an honest empty state whenever a ratio has no denominator. */
export function computeKpi(key: KpiKey, t: Totals): KpiValue {
  switch (key) {
    case 'conversions':
    case 'leads':
      return { kind: 'count', value: t.conversions };
    case 'clicks':
      return { kind: 'count', value: t.clicks };
    case 'impressions':
      return { kind: 'count', value: t.impressions };
    case 'roas':
      if (t.cost <= 0) return { kind: 'empty', reason: NO_SPEND };
      if (t.conversionValue <= 0) return { kind: 'empty', reason: 'لا توجد قيمة تحويل مسجلة' };
      return { kind: 'ratio', value: t.conversionValue / t.cost };
    case 'cpa':
    case 'cpl':
      if (t.conversions <= 0) return { kind: 'empty', reason: NO_CONVERSIONS };
      return { kind: 'money', value: t.cost / t.conversions };
    case 'conversion_rate':
      if (t.clicks <= 0) return { kind: 'empty', reason: NO_CLICKS };
      return { kind: 'percent', value: (t.conversions / t.clicks) * 100 };
    case 'cpc':
      if (t.clicks <= 0) return { kind: 'empty', reason: NO_CLICKS };
      return { kind: 'money', value: t.cost / t.clicks };
    case 'ctr':
      if (t.impressions <= 0) return { kind: 'empty', reason: NO_IMPRESSIONS };
      return { kind: 'percent', value: (t.clicks / t.impressions) * 100 };
    case 'cpm':
      if (t.impressions <= 0) return { kind: 'empty', reason: NO_IMPRESSIONS };
      return { kind: 'money', value: (t.cost / t.impressions) * 1000 };
  }
}

export type DecisionInput = {
  id?: string | null;
  expected_impact?: { delta_sar_per_month?: unknown } | null;
};

/**
 * Largest expected monthly impact among pending recommendations, by absolute
 * size. Returns null when none carries a number, so the UI shows nothing
 * rather than a made up figure.
 */
export function biggestExpectedImpact(items: DecisionInput[]): number | null {
  let best: number | null = null;
  for (const item of items) {
    const raw = item.expected_impact?.delta_sar_per_month;
    if (raw === null || raw === undefined || raw === '') continue;
    const value = Number(raw);
    if (!Number.isFinite(value) || value === 0) continue;
    if (best === null || Math.abs(value) > Math.abs(best)) best = value;
  }
  return best === null ? null : Math.abs(best);
}

/** "توصية واحدة" / "توصيتان" / "3 توصيات" / "11 توصية", with Latin digits. */
export function recommendationCountLabel(count: number, format: (n: number) => string = String) {
  if (count === 1) return 'توصية واحدة';
  if (count === 2) return 'توصيتان';
  if (count >= 3 && count <= 10) return `${format(count)} توصيات`;
  return `${format(count)} توصية`;
}
