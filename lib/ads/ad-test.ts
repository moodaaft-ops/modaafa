import { num, str } from './rows';
import type { GaqlReader } from './assets-reader';

/**
 * Ad test helper: two enabled responsive search ads in one ad group are a
 * test. After enough impressions and conversions it names a winner, with an
 * honest note about what the number can and cannot say.
 *
 * Method (skill: audit-tests-reporting 'اختبار الإعلانات' and search-mastery
 * 20.6): the metric is conversions per impression (CTR alone is not a winner),
 * confidence of at least 90 percent, about four full weeks, at least 1000
 * impressions per ad, and an ad above the allowable CPA cannot win. Only days
 * on which BOTH ads had impressions are compared.
 *
 * Honest limits, repeated in the note: Google does not split impressions
 * evenly (ad rotation favours one ad), so this is an observed comparison, not
 * a randomised experiment; the z-test treats each impression as independent;
 * fractional (data-driven) conversions are rounded.
 */

export const AD_TEST_DEFAULTS = {
  minImpressionsPerAd: 1000,
  minDays: 28,
  minTotalConversions: 30,
  minConfidence: 0.9,
} as const;

export type AdVariantStats = {
  ad_group_ad: string;
  impressions: number;
  clicks: number;
  conversions: number;
  cost: number;
};

export type AdTestConfig = {
  minImpressionsPerAd?: number;
  minDays?: number;
  minTotalConversions?: number;
  minConfidence?: number;
  /** Break-even CPA in account currency, when the merchant's economics are known. */
  allowableCpa?: number | null;
};

export type AdTestStatus = 'collecting' | 'winner' | 'no_clear_difference' | 'cpa_blocks_winner';

export type AdTestVerdict = {
  status: AdTestStatus;
  days_compared: number;
  winner: string | null;
  loser: string | null;
  rates: Array<{ ad_group_ad: string; conversions_per_1000_impressions: number; cpa: number | null }>;
  confidence: number | null;
  lift_pct: number | null;
  note_ar: string;
};

/** Standard normal CDF (Abramowitz and Stegun 7.1.26 erf approximation, error below 1.5e-7). */
export function normalCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const poly = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  const erf = 1 - poly * Math.exp(-z * z);
  return 0.5 * (1 + sign * erf);
}

/** Two-proportion z-test. Returns the two-sided confidence (1 - p) or null when it cannot be computed. */
export function twoProportionConfidence(c1: number, n1: number, c2: number, n2: number): number | null {
  if (n1 <= 0 || n2 <= 0) return null;
  const p1 = c1 / n1;
  const p2 = c2 / n2;
  const pooled = (c1 + c2) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  if (!(se > 0)) return null;
  const z = Math.abs(p1 - p2) / se;
  return Math.max(0, Math.min(1, 2 * normalCdf(z) - 1));
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const pct = (v: number) => `${Math.round(v * 100)}%`;

export function evaluateAdTest(
  a: AdVariantStats,
  b: AdVariantStats,
  daysCompared: number,
  config: AdTestConfig = {}
): AdTestVerdict {
  const cfg = { ...AD_TEST_DEFAULTS, ...config };
  const conv = (v: AdVariantStats) => Math.round(v.conversions);
  const rate = (v: AdVariantStats) => (v.impressions > 0 ? conv(v) / v.impressions : 0);
  const cpa = (v: AdVariantStats) => (conv(v) > 0 ? v.cost / conv(v) : null);
  const rates = [a, b].map((v) => ({
    ad_group_ad: v.ad_group_ad,
    conversions_per_1000_impressions: r1(rate(v) * 1000),
    cpa: cpa(v) === null ? null : Math.round((cpa(v) as number) * 100) / 100,
  }));
  const base = { days_compared: daysCompared, rates };

  const enoughImpressions = a.impressions >= cfg.minImpressionsPerAd && b.impressions >= cfg.minImpressionsPerAd;
  const totalConversions = conv(a) + conv(b);
  if (!enoughImpressions || daysCompared < cfg.minDays || totalConversions < cfg.minTotalConversions) {
    const gaps: string[] = [];
    if (!enoughImpressions) gaps.push(`ظهور لا يقل عن ${cfg.minImpressionsPerAd} لكل إعلان`);
    if (daysCompared < cfg.minDays) gaps.push(`${cfg.minDays} يوم مقارنة (الحين ${daysCompared})`);
    if (totalConversions < cfg.minTotalConversions) gaps.push(`${cfg.minTotalConversions} تحويل بين الإعلانين (الحين ${totalConversions})`);
    return {
      ...base,
      status: 'collecting',
      winner: null,
      loser: null,
      confidence: null,
      lift_pct: null,
      note_ar: `لسا بدري نحكم. نحتاج ${gaps.join(' و')}. القرار يكون على التحويل مو على النقرات.`,
    };
  }

  const confidence = twoProportionConfidence(conv(a), a.impressions, conv(b), b.impressions);
  const higher = rate(a) >= rate(b) ? a : b;
  const lower = higher === a ? b : a;
  const lift = rate(lower) > 0 ? ((rate(higher) - rate(lower)) / rate(lower)) * 100 : null;
  const caveat = 'تنبيه: قوقل ما توزع الظهور بالتساوي، فهذي مقارنة مرصودة مو تجربة محكمة.';

  if (confidence === null || confidence < cfg.minConfidence) {
    return {
      ...base,
      status: 'no_clear_difference',
      winner: null,
      loser: null,
      confidence: confidence === null ? null : Math.round(confidence * 1000) / 1000,
      lift_pct: lift === null ? null : r1(lift),
      note_ar:
        `ما فيه فرق واضح بين الإعلانين: الثقة ${confidence === null ? 'غير محسوبة' : pct(confidence)} والحد الأدنى ${pct(cfg.minConfidence)}. ` +
        `كمّل الاختبار أو اتركهم يشتغلون. ${caveat}`,
    };
  }

  const higherCpa = cpa(higher);
  if (cfg.allowableCpa != null && higherCpa !== null && higherCpa > cfg.allowableCpa) {
    return {
      ...base,
      status: 'cpa_blocks_winner',
      winner: null,
      loser: null,
      confidence: Math.round(confidence * 1000) / 1000,
      lift_pct: lift === null ? null : r1(lift),
      note_ar: `الإعلان الأعلى تحويلاً تكلفة التحويل فيه فوق الحد المسموح، فما نعتبره فايز. ${caveat}`,
    };
  }

  return {
    ...base,
    status: 'winner',
    winner: higher.ad_group_ad,
    loser: lower.ad_group_ad,
    confidence: Math.round(confidence * 1000) / 1000,
    lift_pct: lift === null ? null : r1(lift),
    note_ar:
      `الفايز عنده تحويلات أكثر لكل ظهور بثقة ${pct(confidence)}${lift === null ? '' : ` وفرق ${Math.round(lift)}%`}. ` +
      `نقترح إيقاف الثاني بعد موافقتك، بدون حذف. ${caveat}`,
  };
}

// ---------------------------------------------------------------------------
// Reading the tests from the account
// ---------------------------------------------------------------------------

const TEST_QUERY = `
  SELECT ad_group.resource_name, ad_group.name, ad_group_ad.resource_name, segments.date,
    metrics.impressions, metrics.clicks, metrics.conversions, metrics.cost_micros
  FROM ad_group_ad
  WHERE ad_group_ad.ad.type = 'RESPONSIVE_SEARCH_AD'
    AND ad_group_ad.status = 'ENABLED'
    AND ad_group.status = 'ENABLED'
    AND campaign.status = 'ENABLED'
    AND segments.date DURING LAST_30_DAYS
  LIMIT 10000
`;

export type AdTestResult = {
  ad_group: string;
  ad_group_name: string;
  ads: [string, string];
  verdict: AdTestVerdict;
};

/**
 * Pure: groups the daily rows by ad group, keeps ad groups with exactly two
 * enabled responsive ads, compares only the dates on which both had
 * impressions.
 */
export function buildAdTests(rows: readonly any[], config: AdTestConfig = {}): AdTestResult[] {
  type Day = { impressions: number; clicks: number; conversions: number; cost: number };
  const groups = new Map<string, { name: string; ads: Map<string, Map<string, Day>> }>();
  for (const row of rows) {
    const group = str(row, 'ad_group.resource_name');
    const ad = str(row, 'ad_group_ad.resource_name');
    const date = str(row, 'segments.date');
    if (!group || !ad || !date) continue;
    const entry = groups.get(group) ?? { name: str(row, 'ad_group.name'), ads: new Map() };
    const days = entry.ads.get(ad) ?? new Map<string, Day>();
    const day = days.get(date) ?? { impressions: 0, clicks: 0, conversions: 0, cost: 0 };
    day.impressions += num(row, 'metrics.impressions');
    day.clicks += num(row, 'metrics.clicks');
    day.conversions += num(row, 'metrics.conversions');
    day.cost += num(row, 'metrics.cost_micros') / 1_000_000;
    days.set(date, day);
    entry.ads.set(ad, days);
    groups.set(group, entry);
  }
  const out: AdTestResult[] = [];
  for (const [group, entry] of groups) {
    if (entry.ads.size !== 2) continue;
    const [adA, adB] = [...entry.ads.keys()];
    const daysA = entry.ads.get(adA)!;
    const daysB = entry.ads.get(adB)!;
    const both = [...daysA.keys()].filter((d) => (daysA.get(d)!.impressions > 0) && (daysB.get(d)?.impressions ?? 0) > 0);
    const sum = (ad: string, days: Map<string, Day>): AdVariantStats => {
      const total = { ad_group_ad: ad, impressions: 0, clicks: 0, conversions: 0, cost: 0 };
      for (const d of both) {
        const day = days.get(d)!;
        total.impressions += day.impressions;
        total.clicks += day.clicks;
        total.conversions += day.conversions;
        total.cost += day.cost;
      }
      return total;
    };
    out.push({
      ad_group: group,
      ad_group_name: entry.name,
      ads: [adA, adB],
      verdict: evaluateAdTest(sum(adA, daysA), sum(adB, daysB), both.length, config),
    });
  }
  return out;
}

export async function readAdTests(customer: GaqlReader, config: AdTestConfig = {}): Promise<AdTestResult[] | null> {
  try {
    return buildAdTests(await customer.query(TEST_QUERY), config);
  } catch {
    return null;
  }
}
