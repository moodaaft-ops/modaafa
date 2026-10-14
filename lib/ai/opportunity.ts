/**
 * Winning-search-term detection - the bridge from optimization to GROWTH.
 *
 * The optimizer's six actions all operate inside existing campaigns. This
 * module detects, deterministically, when converting search terms deserve
 * more control, and turns it into a recommendation whose call-to-action is the
 * assistant - not a Google Ads mutation. Nothing here executes; the user
 * reviews the brief in the assistant, and anything it drafts still goes
 * through the normal approval flow.
 *
 * What it suggests follows the google-ads-titan knowledge base (3.5): consolidate,
 * and split only for an economic reason, because a campaign under ~30
 * conversions a month swings and relearns. So the DEFAULT suggestion is to
 * promote the converting terms to EXACT keywords inside the ad group that
 * already earns them (titan 20.3). A separate campaign is suggested only when
 * the cluster alone reached 30 conversions in 30 days, and even then the
 * brief asks for an economic reason to split first.
 */

export type ConvertingTermRow = {
  term: string;
  clicks: number;
  conversions: number;
  cost: number;
  conversion_value: number;
};

/** `exact_keywords`: add the terms as EXACT keywords where they already convert. `new_campaign`: the cluster is big enough to stand alone. */
export type OpportunityMode = 'exact_keywords' | 'new_campaign';

export type CampaignOpportunity = {
  mode: OpportunityMode;
  terms: ConvertingTermRow[];
  totals: { clicks: number; conversions: number; cost: number; conversion_value: number };
  brief_ar: string;
  title_ar: string;
  description_ar: string;
};

const MIN_TERMS = 3;
const MIN_TOTAL_CONVERSIONS = 5;
const MAX_TERMS_IN_BRIEF = 8;

/** Titan 3.5: under 30 conversions in 30 days a campaign swings by up to 100% and relearns for weeks. */
export const MIN_CLUSTER_CONVERSIONS_FOR_NEW_CAMPAIGN = 30;

/** The mode a cluster with this many conversions in 30 days gets. */
export function opportunityMode(clusterConversions30d: number): OpportunityMode {
  return Number.isFinite(clusterConversions30d) && clusterConversions30d >= MIN_CLUSTER_CONVERSIONS_FOR_NEW_CAMPAIGN
    ? 'new_campaign'
    : 'exact_keywords';
}

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
 * Decide whether the converting-terms pool justifies a suggestion, and which.
 * Deterministic thresholds - the LLM writes nothing here, so the numbers in
 * the recommendation are always real.
 *
 * The pool must have at least 3 terms with 2+ conversions each and 5+
 * conversions together. Below 30 conversions in 30 days the suggestion is to
 * add the terms as EXACT keywords where they already convert; from 30 it may
 * be a campaign of its own, if there is an economic reason to split.
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

  const mode = opportunityMode(totals.conversions);
  const top = qualified.slice(0, MAX_TERMS_IN_BRIEF);
  const round = (value: number) => Number(value.toFixed(2));
  const termList = top.map((row) => `«${row.term}» (${row.conversions} تحويل)`).join('، ');
  const avgCpa = totals.conversions > 0 ? round(totals.cost / totals.conversions) : 0;
  const evidence =
    `خلال آخر 30 يوم حققت هذه العبارات ${round(totals.conversions)} تحويل ` +
    `بتكلفة ${round(totals.cost)} ${currencyCode} (متوسط تكلفة التحويل ${avgCpa} ${currencyCode}) ` +
    `وهي تشتغل الحين داخل حملاتك الحالية.`;

  let title_ar: string;
  let description_ar: string;
  let brief_ar: string;

  if (mode === 'new_campaign') {
    title_ar = `فرصة نمو: ${qualified.length} عبارات بحث رابحة وصلت ${round(totals.conversions)} تحويل وتستحق تنظر لحملة لحالها`;
    description_ar =
      `${evidence} هذا حجم يكفي حملة مستقلة (30 تحويل أو أكثر في الشهر). ` +
      `بس لا تفصلها لمجرد إنها رابحة. افصلها إذا لها اقتصاد مختلف عن باقي الحساب، مثل هامش أو مدينة بميزانية مستقلة أو لغة إعلان أو براند. ` +
      `غير كذا خلها مجمعة، لأن كل حملة زيادة تقسم التعلم. افتح المساعد وسيجهّز لك مسودة للمراجعة.`;
    brief_ar =
      `جهّز لي مسودة حملة بحث مخصصة للعبارات الرابحة التالية من حسابي: ${termList}. ` +
      `هذه العبارات حققت ${round(totals.conversions)} تحويل بتكلفة إجمالية ${round(totals.cost)} ${currencyCode} خلال آخر 30 يوم. ` +
      `قل لي أول شي إذا فيه سبب اقتصادي للفصل عن حملاتي الحالية (هامش أو مدينة أو لغة أو براند)، وإذا ما فيه خلها مجمعة. ` +
      `لو فيه سبب، اقترح هيكل المجموعات الإعلانية والمطابقة المناسبة وعناوين ووصف الإعلانات، وبدون أي توقع لأرقام النقرات أو التحويلات.`;
  } else {
    title_ar = `${qualified.length} عبارات بحث تحوّل تستاهل تضيفها كلمات مطابقة تامة`;
    description_ar =
      `${evidence} أنصحك تضيفها كلمات مطابقة تامة (Exact) داخل نفس المجموعة الإعلانية اللي جابتها، ` +
      `عشان تتحكم في سعر النقرة والإعلان بدون ما تفتّت حسابك على حملات صغيرة. ` +
      `العبارة العامة جداً اللي تحوّل لأن البحث واسع اتركها مثل ما هي. ` +
      `حملة جديدة منفصلة ما تستاهل إلا لما تتجاوز العبارات 30 تحويل في الشهر.`;
    brief_ar =
      `راجع العبارات الرابحة التالية من حسابي وجهّز لي كلمات مطابقة تامة (Exact) أضيفها داخل نفس المجموعة الإعلانية اللي جابتها، بدون حملة جديدة: ${termList}. ` +
      `هذه العبارات حققت ${round(totals.conversions)} تحويل بتكلفة إجمالية ${round(totals.cost)} ${currencyCode} خلال آخر 30 يوم. ` +
      `استبعد العبارات العامة جداً، وقل لي إذا فيه منها عبارات تحتاج سلبيات.`;
  }

  return {
    mode,
    terms: top,
    totals: { ...totals, cost: round(totals.cost), conversions: round(totals.conversions), conversion_value: round(totals.conversion_value) },
    brief_ar,
    title_ar,
    description_ar,
  };
}
