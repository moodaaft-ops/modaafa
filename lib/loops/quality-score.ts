/**
 * Quality Score decision rules for the keywords that spend the most
 * (google-ads-titan keywords-search-terms 7.5).
 *
 * Google gives each keyword a 1 to 10 score and three components, each
 * BELOW_AVERAGE, AVERAGE or ABOVE_AVERAGE: expected CTR, ad relevance and
 * landing page experience. The score is a diagnosis, not a target: it is read
 * only for the keywords with real spend and a score under 7 (6 is acceptable,
 * under 6 with high spend has big room, 1 to 4 are treated first), and each
 * weak component maps to one concrete suggestion:
 *
 *   ad relevance below average     rewrite the ad around the keyword; when two or
 *                                  more big keywords of the SAME ad group are weak
 *                                  on it, the group mixes themes: split it
 *   landing page below average     fix the landing page (speed, message match, mobile)
 *   expected CTR below average     rewrite headlines around the offer, read the
 *                                  competitors' ads, tighten the match type
 *
 * These are RECOMMENDATIONS for the monthly report and for Jarvis to explain.
 * Nothing here changes an account.
 *
 * GAQL fields (v22 keyword_view): ad_group_criterion.quality_info.quality_score,
 * .creative_quality_score, .post_click_quality_score, .search_predicted_ctr.
 * Not verified against a live account; a rejected query returns null.
 */

import { currencyUnits, num, str } from '../jarvis/tools/shared';
import type { Customer } from './auction-insights';

export type ComponentRating = 'BELOW_AVERAGE' | 'AVERAGE' | 'ABOVE_AVERAGE' | null;

export type QualityKeyword = {
  keyword: string;
  match_type: string;
  ad_group: string;
  ad_group_resource: string;
  campaign: string;
  quality_score: number | null;
  ad_relevance: ComponentRating;
  landing_page: ComponentRating;
  expected_ctr: ComponentRating;
  cost: number;
  clicks: number;
  impressions: number;
};

export type SuggestionKind = 'split_ad_group' | 'rewrite_ad' | 'fix_landing' | 'improve_ctr';

export type QualitySuggestion = { kind: SuggestionKind; text_ar: string };

export type QualityFinding = {
  keyword: string;
  ad_group: string;
  campaign: string;
  quality_score: number;
  priority: 'high' | 'normal';
  components: { ad_relevance: ComponentRating; landing_page: ComponentRating; expected_ctr: ComponentRating };
  cost: number;
  share_of_scanned_spend_pct: number | null;
  suggestions: QualitySuggestion[];
};

export const QS_ACTION_BELOW = 7;
export const QS_HIGH_PRIORITY_AT_MOST = 4;
export const TOP_SPEND_KEYWORDS = 10;
/** Big keywords of one ad group weak on ad relevance before the group is called mixed. */
export const SPLIT_MIN_WEAK_KEYWORDS = 2;

function rating(value: string): ComponentRating {
  return value === 'BELOW_AVERAGE' || value === 'AVERAGE' || value === 'ABOVE_AVERAGE' ? value : null;
}

const QUALITY_QUERY = `
  SELECT ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type,
    ad_group_criterion.quality_info.quality_score,
    ad_group_criterion.quality_info.creative_quality_score,
    ad_group_criterion.quality_info.post_click_quality_score,
    ad_group_criterion.quality_info.search_predicted_ctr,
    ad_group.name, ad_group.resource_name, campaign.name,
    metrics.cost_micros, metrics.clicks, metrics.impressions
  FROM keyword_view
  WHERE segments.date DURING LAST_30_DAYS
    AND ad_group_criterion.status = 'ENABLED'
    AND metrics.cost_micros > 0
  ORDER BY metrics.cost_micros DESC
  LIMIT 40
`;

export function mapQualityRows(rows: any[]): QualityKeyword[] {
  return (rows ?? [])
    .map((row) => {
      const score = num(row, 'ad_group_criterion.quality_info.quality_score');
      return {
        keyword: str(row, 'ad_group_criterion.keyword.text').trim(),
        match_type: str(row, 'ad_group_criterion.keyword.match_type'),
        ad_group: str(row, 'ad_group.name'),
        ad_group_resource: str(row, 'ad_group.resource_name'),
        campaign: str(row, 'campaign.name'),
        quality_score: score !== null && score >= 1 && score <= 10 ? score : null,
        ad_relevance: rating(str(row, 'ad_group_criterion.quality_info.creative_quality_score')),
        landing_page: rating(str(row, 'ad_group_criterion.quality_info.post_click_quality_score')),
        expected_ctr: rating(str(row, 'ad_group_criterion.quality_info.search_predicted_ctr')),
        cost: currencyUnits(row, 'metrics.cost_micros'),
        clicks: num(row, 'metrics.clicks') ?? 0,
        impressions: num(row, 'metrics.impressions') ?? 0,
      };
    })
    .filter((row) => row.keyword.length > 0);
}

/** The top-spend keywords with their scores, or null when Google refuses the read. */
export async function readQualityKeywords(customer: Customer): Promise<QualityKeyword[] | null> {
  try {
    return mapQualityRows(await customer.query(QUALITY_QUERY));
  } catch {
    return null;
  }
}

const SUGGESTION_TEXT: Record<SuggestionKind, string> = {
  split_ad_group: 'قسّم المجموعة: كلماتها تغطي مواضيع مختلفة وإعلان واحد ما يناسبها كلها. سوِّ مجموعة لكل موضوع بإعلانه وصفحته',
  rewrite_ad: 'أعد كتابة الإعلان وحط كلمات البحث نفسها في العناوين، لأن صلة الإعلان بالكلمة ضعيفة',
  fix_landing: 'راجع صفحة الهبوط: سرعتها على الجوال، وإن أول شاشة تقول نفس اللي في الإعلان والكلمة، وزر التواصل واضح',
  improve_ctr: 'قوّي العناوين بالعرض الواضح، وشف إعلانات المنافسين على نفس الكلمة، وضيّق نوع المطابقة لو الكلمة واسعة',
};

/**
 * The decision rules. `keywords` is the top-spend list (already sorted by cost,
 * or not: it is sorted here). Returns at most one finding per keyword, high
 * priority first.
 */
export function qualityFindings(keywords: readonly QualityKeyword[]): QualityFinding[] {
  const top = [...keywords].sort((a, b) => b.cost - a.cost).slice(0, TOP_SPEND_KEYWORDS);
  const scannedSpend = top.reduce((sum, k) => sum + k.cost, 0);

  // A weak ad relevance across several big keywords of one ad group means the group mixes themes.
  const weakRelevanceByGroup = new Map<string, number>();
  for (const k of top) {
    if (k.quality_score !== null && k.quality_score < QS_ACTION_BELOW && k.ad_relevance === 'BELOW_AVERAGE') {
      weakRelevanceByGroup.set(k.ad_group_resource, (weakRelevanceByGroup.get(k.ad_group_resource) ?? 0) + 1);
    }
  }

  const findings: QualityFinding[] = [];
  for (const k of top) {
    if (k.quality_score === null || k.quality_score >= QS_ACTION_BELOW) continue;
    const suggestions: QualitySuggestion[] = [];
    if (k.ad_relevance === 'BELOW_AVERAGE') {
      const mixed = (weakRelevanceByGroup.get(k.ad_group_resource) ?? 0) >= SPLIT_MIN_WEAK_KEYWORDS;
      const kind: SuggestionKind = mixed ? 'split_ad_group' : 'rewrite_ad';
      suggestions.push({ kind, text_ar: SUGGESTION_TEXT[kind] });
    }
    if (k.landing_page === 'BELOW_AVERAGE') suggestions.push({ kind: 'fix_landing', text_ar: SUGGESTION_TEXT.fix_landing });
    if (k.expected_ctr === 'BELOW_AVERAGE') suggestions.push({ kind: 'improve_ctr', text_ar: SUGGESTION_TEXT.improve_ctr });
    // A weak score with no component below average still needs a first step: read the ad and the page together.
    if (suggestions.length === 0) {
      suggestions.push({ kind: 'rewrite_ad', text_ar: SUGGESTION_TEXT.rewrite_ad });
    }
    findings.push({
      keyword: k.keyword,
      ad_group: k.ad_group,
      campaign: k.campaign,
      quality_score: k.quality_score,
      priority: k.quality_score <= QS_HIGH_PRIORITY_AT_MOST ? 'high' : 'normal',
      components: { ad_relevance: k.ad_relevance, landing_page: k.landing_page, expected_ctr: k.expected_ctr },
      cost: Math.round(k.cost * 100) / 100,
      share_of_scanned_spend_pct: scannedSpend > 0 ? Math.round((k.cost / scannedSpend) * 1000) / 10 : null,
      suggestions,
    });
  }
  return findings.sort(
    (a, b) => (a.priority === b.priority ? b.cost - a.cost : a.priority === 'high' ? -1 : 1)
  );
}
