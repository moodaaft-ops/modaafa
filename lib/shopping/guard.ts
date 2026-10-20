import { formatNumber } from '@/lib/lifecycle/format';
import type { GuardFinding, GuardSignals } from '../guard/types';

/**
 * Morning-guard rule: a large share of the Merchant Center feed is not
 * eligible to show. Pure: it reads today's feed and the optional previous day.
 *
 * Historical comparison is optional; the level rule remains available on the first day.
 * Complete consecutive snapshots also detect day-over-day spikes. The finding is re-announced only
 * when the main problem changes (dedupe key carries the top issue code).
 */
export const MIN_PRODUCTS_FOR_ALERT = 20;
export const MIN_NOT_ELIGIBLE_FOR_ALERT = 10;
export const NOT_ELIGIBLE_HIGH_SHARE = 0.2;
export const NOT_ELIGIBLE_CRITICAL_SHARE = 0.5;

const pct = (ratio: number) => `${formatNumber(Math.round(ratio * 100))}%`;

export function detectProductDisapprovals(signals: GuardSignals): GuardFinding[] {
  if (signals.ok.shopping !== true || !signals.shopping) return [];
  const feed = signals.shopping;
  if (feed.total < MIN_PRODUCTS_FOR_ALERT || feed.not_eligible < MIN_NOT_ELIGIBLE_FOR_ALERT) return [];
  const previous = signals.shoppingPrevious;
  // A comparable, complete daily pair detects a jump even below the level threshold.
  const spike = previous && !previous.truncated && !feed.truncated && previous.total >= MIN_PRODUCTS_FOR_ALERT
    && feed.not_eligible - previous.not_eligible >= MIN_NOT_ELIGIBLE_FOR_ALERT
    && feed.not_eligible_share - previous.not_eligible_share >= 0.1;
  if (feed.not_eligible_share < NOT_ELIGIBLE_HIGH_SHARE && !spike) return [];

  const top = feed.issues.find((i) => i.severity === 'DISAPPROVED') ?? feed.issues[0] ?? null;
  const severity = feed.not_eligible_share >= NOT_ELIGIBLE_CRITICAL_SHARE ? 'critical' : 'high';
  const what = `${formatNumber(feed.not_eligible)} منتج من ${formatNumber(feed.total)} (${pct(feed.not_eligible_share)}) مرفوض في قوقل ميرشنت وما يظهر في إعلانات التسوق`;
  const step = top
    ? `أكثر سبب: ${top.code.replace(/_/g, ' ')}${top.attribute ? ` في حقل ${top.attribute}` : ''}. صلّحه في ملف المنتجات وتنحل الحالات تلقائياً`
    : 'افتح تشخيص المنتجات في ميرشنت سنتر وصلّح الأسباب المذكورة';
  return [
    {
      code: 'product_disapprovals',
      severity,
      entityType: 'account',
      entityId: signals.customerId,
      entityName: null,
      whatAr: what,
      stepAr: step,
      evidence: {
        day_over_day_spike: Boolean(spike),
        previous_not_eligible: previous?.not_eligible ?? null,
        previous_not_eligible_share: previous?.not_eligible_share ?? null,
        total: feed.total,
        not_eligible: feed.not_eligible,
        eligible_limited: feed.eligible_limited,
        not_eligible_share: feed.not_eligible_share,
        truncated: feed.truncated,
        top_issues: feed.issues.slice(0, 3).map((i) => ({ code: i.code, severity: i.severity, products: i.products })),
      },
      dedupeKey: `product_disapprovals:${severity}:${top?.code ?? 'none'}`,
      escalation: 'none',
      cause: null,
    },
  ];
}
