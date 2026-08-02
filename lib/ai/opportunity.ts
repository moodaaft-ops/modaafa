/**
 * Campaign-opportunity detection — the bridge from optimization to GROWTH.
 *
 * The optimizer's six actions all operate inside existing campaigns. But the
 * biggest move a veteran buyer makes is structural: "these winning queries
 * deserve their own campaign, with their own budget and ads." This module
 * detects that moment deterministically from converting search terms and turns
 * it into a recommendation whose call-to-action is the campaign BUILDER — not
 * a Google Ads mutation. Nothing here executes; the user reviews the brief in
 * the assistant, and the draft still goes through the normal approval flow.
 */

export type ConvertingTermRow = {
  term: string;
  clicks: number;
  conversions: number;
  cost: number;
  conversion_value: number;
};

export type CampaignOpportunity = {
  terms: ConvertingTermRow[];
  totals: { clicks: number; conversions: number; cost: number; conversion_value: number };
  brief_ar: string;
  title_ar: string;
  description_ar: string;
};

const MIN_TERMS = 3;
const MIN_TOTAL_CONVERSIONS = 5;
const MAX_TERMS_IN_BRIEF = 8;

/** Normalize the raw GAQL rows (camelCase or snake_case) into typed terms. */
export function mapConvertingTermRows(rows: any[]): ConvertingTermRow[] {
  const mapped = (rows ?? [])
    .map((row: any) => {
      const metrics = row?.metrics ?? {};
      return {
        term: String(row?.searchTermView?.searchTerm ?? row?.search_term_view?.search_term ?? '').trim(),
        clicks: Number(metrics.clicks ?? 0),
        conversions: Number(metrics.conversions ?? 0),
        cost: Number(metrics.costMicros ?? metrics.cost_micros ?? 0) / 1_000_000,
        conversion_value: Number(metrics.conversionsValue ?? metrics.conversions_value ?? 0),
      };
    })
    .filter((row) => row.term.length > 0);

  // GAQL can return the same search term once per ad group. A campaign
  // opportunity is about distinct demand themes, so counting those rows as
  // separate terms would manufacture a cluster that does not really exist.
  const distinct = new Map<string, ConvertingTermRow>();
  for (const row of mapped) {
    const key = row.term.replace(/\s+/g, ' ').trim().toLocaleLowerCase('ar');
    const existing = distinct.get(key);
    if (existing) {
      existing.clicks += row.clicks;
      existing.conversions += row.conversions;
      existing.cost += row.cost;
      existing.conversion_value += row.conversion_value;
    } else {
      distinct.set(key, { ...row, term: row.term.replace(/\s+/g, ' ').trim() });
    }
  }
  return [...distinct.values()];
}

/**
 * Decide whether the converting-terms pool justifies proposing a NEW campaign.
 * Deterministic thresholds — the LLM writes nothing here, so the numbers in
 * the recommendation are always real.
 */
export function detectCampaignOpportunity(
  terms: ConvertingTermRow[],
  currencyCode = 'SAR'
): CampaignOpportunity | null {
  const qualified = terms
    .filter((row) => row.conversions >= 2)
    .sort((a, b) => b.conversions - a.conversions);

  if (qualified.length < MIN_TERMS) return null;
  const totals = qualified.reduce(
    (acc, row) => ({
      clicks: acc.clicks + row.clicks,
      conversions: acc.conversions + row.conversions,
      cost: acc.cost + row.cost,
      conversion_value: acc.conversion_value + row.conversion_value,
    }),
    { clicks: 0, conversions: 0, cost: 0, conversion_value: 0 }
  );
  if (totals.conversions < MIN_TOTAL_CONVERSIONS) return null;

  const top = qualified.slice(0, MAX_TERMS_IN_BRIEF);
  const round = (value: number) => Number(value.toFixed(2));
  const termList = top.map((row) => `«${row.term}» (${row.conversions} تحويل)`).join('، ');
  const avgCpa = totals.conversions > 0 ? round(totals.cost / totals.conversions) : 0;

  const title_ar = `فرصة نمو: ${qualified.length} عبارات بحث رابحة تستحق حملة مخصصة`;
  const description_ar =
    `خلال آخر 30 يوماً حققت هذه العبارات ${round(totals.conversions)} تحويلاً ` +
    `بتكلفة ${round(totals.cost)} ${currencyCode} (متوسط تكلفة التحويل ${avgCpa} ${currencyCode}) ` +
    `وهي تعمل الآن داخل حملات عامة. حملة مخصصة لها تعني ميزانية محمية، إعلانات مطابقة للنية، وجودة أعلى — ` +
    `عادةً بتكلفة تحويل أقل. افتح المساعد وسيجهّز لك مسودة الحملة كاملة للمراجعة.`;

  const brief_ar =
    `ابنِ لي حملة بحث جديدة مخصصة للعبارات الرابحة التالية من حسابي: ${termList}. ` +
    `هذه العبارات حققت ${round(totals.conversions)} تحويلاً بتكلفة إجمالية ${round(totals.cost)} ${currencyCode} خلال آخر 30 يوماً. ` +
    `اقترح هيكل المجموعات الإعلانية، الكلمات بنوع المطابقة المناسب، عناوين ووصف الإعلانات، وميزانية يومية مناسبة بناءً على هذا الأداء.`;

  return { terms: top, totals: { ...totals, cost: round(totals.cost), conversions: round(totals.conversions), conversion_value: round(totals.conversion_value) }, brief_ar, title_ar, description_ar };
}
