import { getAnthropicClient, getModelForAgent } from './client';
import type { AccountSnapshot } from '../google-ads/audit-queries';

/**
 * Audit Agent - takes a Google Ads account snapshot and produces:
 * - health_score (0-100)
 * - category breakdowns
 * - prioritized recommendations
 *
 * The Arabic-first system prompt is critical: customers see findings in Arabic,
 * but the underlying analysis is in English so Claude can match the technical Google Ads
 * terminology cleanly.
 */

const anthropic = getAnthropicClient();
const MODEL = getModelForAgent('audit'); // Opus 4.7 - highest quality

const SYSTEM_PROMPT = `You are an expert Google Ads media buyer with 10+ years of experience auditing accounts in the MENA region. You are part of Modaafa, a SaaS platform that helps SMB advertisers optimize their Google Ads accounts.

Your task: review the structured account snapshot below and produce a JSON audit report. Be specific and actionable — every recommendation must be one a real media buyer would make and one we can execute via the Google Ads API.

CATEGORIES TO ANALYZE
1. Account Structure — campaign organization, ad-group quantity, naming conventions
2. Ad Quality — Quality Score, ad strength, missing assets (sitelinks, callouts)
3. Keywords — coverage, match types, low-performers, missing opportunities
4. Negative Keywords — gaps causing wasted spend
5. Bidding Strategy — appropriateness for account stage and conversion volume
6. Budget Allocation — campaigns hitting budget vs. underspending
7. Targeting — geographic, demographic, dayparting efficiency

OUTPUT
Return ONLY a JSON object matching this TypeScript shape (no markdown, no commentary):

{
  "health_score": number,                      // 0-100 overall
  "category_scores": {
    "structure": number,                        // 0-100 each
    "ad_quality": number,
    "keywords": number,
    "negative_keywords": number,
    "bidding": number,
    "budget": number,
    "targeting": number
  },
  "estimated_monthly_waste_sar": number,        // estimated wasted spend per month
  "summary_ar": string,                          // 2-3 sentence overview in Arabic
  "summary_en": string,                          // same in English
  "findings": [
    {
      "category": "bidding"|"keywords"|"ads"|"structure"|"budget"|"targeting"|"extensions",
      "severity": "critical"|"medium"|"growth",
      "title_ar": string,                        // short title in Arabic
      "title_en": string,
      "description_ar": string,                  // 1-2 sentences explaining the issue
      "description_en": string,
      "expected_impact": {
        "metric": "roas"|"cpa"|"conversions"|"ctr"|"cost",
        "delta_pct": number,                     // expected % change (positive = improvement)
        "delta_sar_per_month": number            // expected absolute SAR/month impact
      },
      "action_payload": {                        // what we'd execute via the API
        "operation": string,                      // e.g. "pause_keyword", "add_negative", "increase_budget"
        "details": object                         // operation-specific params
      }
    }
  ]
}

GUIDELINES
- Sort findings by impact (largest expected_impact first).
- Maximum 15 findings — focus on the most impactful.
- For Arabic strings, use natural Saudi/Gulf phrasing (e.g. "بدّل" instead of "غيّر", numbers as ٠١٢٣٤٥٦٧٨٩).
- Currency in SAR (ر.س).
- Never recommend creating a new Google Ads account — customers already have one.
- If the account is healthy, return fewer findings — quality over quantity.
- The expected_impact numbers should be realistic, not aspirational.`;

export interface AuditResult {
  health_score: number;
  category_scores: Record<string, number>;
  estimated_monthly_waste_sar: number;
  summary_ar: string;
  summary_en: string;
  findings: Array<{
    category: string;
    severity: 'critical' | 'medium' | 'growth';
    title_ar: string;
    title_en: string;
    description_ar: string;
    description_en: string;
    expected_impact: {
      metric: string;
      delta_pct: number;
      delta_sar_per_month: number;
    };
    action_payload: {
      operation: string;
      details: Record<string, unknown>;
    };
  }>;
}

export async function runAudit(snapshot: AccountSnapshot): Promise<AuditResult> {
  // Compress snapshot to keep within token budget
  const compressed = compressSnapshot(snapshot);

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 8000,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Analyze this Google Ads account snapshot and produce the JSON audit report.\n\n<snapshot>\n${JSON.stringify(compressed, null, 2)}\n</snapshot>`,
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('No text response from Claude');
  }

  const json = extractJson(textBlock.text);
  return JSON.parse(json) as AuditResult;
}

/**
 * Strip noisy fields and convert micros to SAR for the AI's context.
 * Significantly reduces token usage.
 */
function compressSnapshot(s: AccountSnapshot): Record<string, unknown> {
  const microsToSar = (m: any) => (Number(m ?? 0) / 1_000_000).toFixed(2);

  return {
    account: {
      currency: s.accountInfo.currency_code,
      timezone: s.accountInfo.time_zone,
    },
    campaigns: s.campaigns.map((c: any) => ({
      id: c.campaign?.id,
      name: c.campaign?.name,
      status: c.campaign?.status,
      type: c.campaign?.advertising_channel_type,
      bidding: c.campaign?.bidding_strategy_type,
      daily_budget_sar: microsToSar(c.campaign_budget?.amount_micros),
      cost_30d_sar: microsToSar(c.metrics?.cost_micros),
      clicks_30d: c.metrics?.clicks,
      conversions_30d: c.metrics?.conversions,
      conv_value_30d_sar: microsToSar(c.metrics?.conversions_value ? Number(c.metrics.conversions_value) * 1_000_000 : 0),
      ctr: c.metrics?.ctr,
    })),
    adgroup_count: s.adGroups.length,
    keyword_count: s.keywords.length,
    avg_quality_score:
      s.keywords.reduce((sum: number, k: any) => sum + (k.ad_group_criterion?.quality_info?.quality_score ?? 0), 0) /
      Math.max(1, s.keywords.length),
    underperforming_keywords: s.underperformingKeywords.slice(0, 30).map((k: any) => ({
      text: k.ad_group_criterion?.keyword?.text,
      cost_30d_sar: microsToSar(k.metrics?.cost_micros),
      clicks: k.metrics?.clicks,
      ctr: k.metrics?.ctr,
    })),
    wasted_search_terms: s.searchTermsWithoutConversions.slice(0, 50).map((t: any) => ({
      term: t.search_term_view?.search_term,
      cost_sar: microsToSar(t.metrics?.cost_micros),
      clicks: t.metrics?.clicks,
    })),
    low_quality_ads_count: s.lowQualityAds.length,
    negative_keyword_count: s.negativeKeywords.length,
    geo_top_5: s.geoPerformance.slice(0, 5).map((g: any) => ({
      region: g.segments?.geo_target_region,
      cost_sar: microsToSar(g.metrics?.cost_micros),
      conversions: g.metrics?.conversions,
    })),
  };
}

function extractJson(text: string): string {
  // Claude usually returns clean JSON, but strip markdown fences just in case
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) return fenced[1];
  return text.trim();
}
