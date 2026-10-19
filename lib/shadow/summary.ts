/**
 * Weekly agreement between the optimizer and the operator, pure.
 *
 *   agreePct       right / (right + wrong), over the decisions that were reviewed
 *   coveragePct    reviewed decisions / all decisions in the week
 *   missesBy       "فاتك شي" entries, grouped by category
 * Null where there is nothing to divide by; never a made-up number.
 */

export const SHADOW_CATEGORIES = ['negatives', 'keywords', 'budget', 'bidding', 'ads', 'tracking', 'structure', 'other'] as const;
export type ShadowCategory = (typeof SHADOW_CATEGORIES)[number];

export const SHADOW_CATEGORY_LABELS_AR: Record<ShadowCategory, string> = {
  negatives: 'كلمات سلبية',
  keywords: 'كلمات مفتاحية',
  budget: 'ميزانية',
  bidding: 'مزايدة وأهداف',
  ads: 'إعلانات',
  tracking: 'قياس',
  structure: 'هيكل الحساب',
  other: 'غير ذلك',
};

export type ShadowVerdict = 'right' | 'wrong' | 'missed';

export type ShadowDecisionRow = { id: string; account_id: string; category: string; created_at: string };
export type ShadowReviewRow = {
  id: string;
  account_id: string;
  decision_id: string | null;
  verdict: ShadowVerdict;
  category: string;
  created_at: string;
};

export type AgreementSummary = {
  decisions: number;
  reviewed: number;
  right: number;
  wrong: number;
  missed: number;
  agreePct: number | null;
  coveragePct: number | null;
  missesBy: Array<{ category: ShadowCategory; count: number }>;
  wrongBy: Array<{ category: ShadowCategory; count: number }>;
};

export function normalizeShadowCategory(value: unknown): ShadowCategory {
  return SHADOW_CATEGORIES.includes(value as ShadowCategory) ? (value as ShadowCategory) : 'other';
}

export function categoryForActionType(actionType: string): ShadowCategory {
  switch (actionType) {
    case 'add_negative_keyword':
    case 'add_negative_keywords_batch':
      return 'negatives';
    case 'pause_keyword':
    case 'add_keyword':
      return 'keywords';
    case 'adjust_budget':
      return 'budget';
    case 'adjust_bid':
      return 'bidding';
    case 'pause_ad':
      return 'ads';
    case 'pause_campaign':
    case 'enable_campaign':
      return 'structure';
    default:
      return 'other';
  }
}

/** Monday 00:00 UTC of the week that contains `date`. */
export function weekStartUtc(date: Date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const back = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  return d;
}

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : null);

function tally(rows: Array<{ category: string }>) {
  const counts = new Map<ShadowCategory, number>();
  for (const row of rows) {
    const category = normalizeShadowCategory(row.category);
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
}

export function weeklyAgreement(
  decisions: ShadowDecisionRow[],
  reviews: ShadowReviewRow[],
  weekStart: Date
): AgreementSummary {
  const from = weekStart.getTime();
  const to = from + 7 * 86_400_000;
  const inWeek = (iso: string) => {
    const t = Date.parse(iso);
    return Number.isFinite(t) && t >= from && t < to;
  };
  const weekDecisions = decisions.filter((d) => inWeek(d.created_at));
  const decisionIds = new Set(weekDecisions.map((d) => d.id));
  const decisionCategory = new Map(weekDecisions.map((d) => [d.id, d.category]));

  // Verdicts on this week's decisions, one per decision (the latest wins).
  const latest = new Map<string, ShadowReviewRow>();
  for (const review of reviews) {
    if (review.verdict === 'missed' || !review.decision_id || !decisionIds.has(review.decision_id)) continue;
    const prev = latest.get(review.decision_id);
    if (!prev || Date.parse(review.created_at) >= Date.parse(prev.created_at)) latest.set(review.decision_id, review);
  }
  const verdicts = [...latest.values()];
  const right = verdicts.filter((v) => v.verdict === 'right').length;
  const wrong = verdicts.filter((v) => v.verdict === 'wrong').length;
  const misses = reviews.filter((r) => r.verdict === 'missed' && inWeek(r.created_at));

  return {
    decisions: weekDecisions.length,
    reviewed: verdicts.length,
    right,
    wrong,
    missed: misses.length,
    agreePct: pct(right, right + wrong),
    coveragePct: pct(verdicts.length, weekDecisions.length),
    missesBy: tally(misses),
    wrongBy: tally(verdicts.filter((v) => v.verdict === 'wrong').map((v) => ({ category: decisionCategory.get(v.decision_id!) ?? v.category }))),
  };
}
