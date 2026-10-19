import type { JarvisReadTool, ToolContext, ToolResult } from './types';
import {
  INVALID_INPUT_MESSAGE_AR,
  READ_FAILED_MESSAGE_AR,
  ToolInputError,
  UNKNOWN_TOOL_MESSAGE_AR,
  errorSummary,
  failResult,
} from './shared';
import { getCampaignsTool } from './get-campaigns';
import { getSearchTermsTool } from './get-search-terms';
import { getKeywordsTool } from './get-keywords';
import { getConversionHealthTool } from './get-conversion-health';
import { getGeoTool } from './get-geo';
import { getScheduleTool } from './get-schedule';
import { getDevicesTool } from './get-devices';
import { getAdsStatusTool } from './get-ads-status';
import { getChangeHistoryTool } from './get-change-history';
import { getPmaxCategoriesTool } from './get-pmax-categories';
import { getGoogleRecommendationsTool } from './get-google-recommendations';
import { getAdAssetsTool } from './get-ad-assets';
import { getValueRulesTool } from './get-value-rules';
import { getShoppingHealthTool } from './get-shopping-health';
import { isShoppingHealthEnabled } from '@/lib/shopping/flag';
import { isAdsStudioEnabled } from '@/lib/ads/flag';
import { isExtendedActionsEnabled } from '@/lib/ai/extended-actions/flag';
import { getNgramAnalysisTool } from './get-ngram-analysis';
import { getAuctionInsightsTool } from './get-auction-insights';
import { getQualityScoreTool } from './get-quality-score';
import { isMonthlyReviewEnabled, isNgramEnabled } from '@/lib/loops/flags';
import { getLandingCheckTool } from './get-landing-check';
import { landingCheckEnabled } from '@/lib/landing-check/flag';
import { getResponseCoachingTool } from './get-response-coaching';
import { offerCoachingEnabled } from '@/lib/coaching/flag';

export type { EvidenceKind, EvidenceRow, GaqlCustomer, JarvisReadTool, ToolContext, ToolResult } from './types';
export { conversionVerdict } from './get-conversion-health';

const BASE_READ_TOOLS: readonly JarvisReadTool[] = [
  getCampaignsTool,
  getSearchTermsTool,
  getKeywordsTool,
  getConversionHealthTool,
  getGeoTool,
  getScheduleTool,
  getDevicesTool,
  getAdsStatusTool,
  getChangeHistoryTool,
  getPmaxCategoriesTool,
  // Behind EXTENDED_ACTIONS_ENABLED (read at load): flag off keeps the tool list byte-identical.
  ...(isExtendedActionsEnabled() ? [getGoogleRecommendationsTool, getValueRulesTool] : []),
  // Behind ADS_STUDIO_ENABLED (read at load): read-only, so it does not need the extended flag.
  ...(isAdsStudioEnabled() ? [getAdAssetsTool] : []),
  // Behind SHOPPING_HEALTH_ENABLED (read at load): read-only.
  ...(isShoppingHealthEnabled() ? [getShoppingHealthTool] : []),
];

/**
 * Tools of the weekly and monthly loops. They are listed to the model only
 * when their switch was on at start-up (NGRAM_ENABLED, MONTHLY_REVIEW_ENABLED),
 * and each one checks the switch again when it runs.
 */
const LOOP_READ_TOOLS: readonly JarvisReadTool[] = [
  ...(isNgramEnabled() ? [getNgramAnalysisTool] : []),
  ...(isMonthlyReviewEnabled() ? [getAuctionInsightsTool, getQualityScoreTool] : []),
];

// Behind LANDING_CHECK_ENABLED and OFFER_COACHING_ENABLED (default off): flag off adds nothing.
const TRUST_READ_TOOLS: readonly JarvisReadTool[] = [
  ...(landingCheckEnabled() ? [getLandingCheckTool] : []),
  ...(offerCoachingEnabled() ? [getResponseCoachingTool] : []),
];

export const JARVIS_READ_TOOLS: readonly JarvisReadTool[] = [...BASE_READ_TOOLS, ...LOOP_READ_TOOLS, ...TRUST_READ_TOOLS];

const TOOLS_BY_NAME: ReadonlyMap<string, JarvisReadTool> = new Map(
  [...BASE_READ_TOOLS, getNgramAnalysisTool, getAuctionInsightsTool, getQualityScoreTool, getLandingCheckTool, getResponseCoachingTool].map((tool) => [tool.name, tool])
);

/**
 * Validates and runs one read tool. Never throws: a bad input, an unknown tool
 * or any Google Ads failure becomes `{ ok: false }` with an Arabic message the
 * brain can pass on. Error codes are fixed strings, so nothing from Google (or
 * from the model's own input) is echoed back into the conversation.
 */
export async function runReadTool(name: string, input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const tool = typeof name === 'string' ? TOOLS_BY_NAME.get(name) : undefined;
  if (!tool) return failResult('unknown_tool', UNKNOWN_TOOL_MESSAGE_AR);

  try {
    return await tool.run(input, ctx);
  } catch (error) {
    if (error instanceof ToolInputError) {
      return failResult(`invalid_input: ${error.detail}`, INVALID_INPUT_MESSAGE_AR);
    }
    console.warn(`[jarvis-tools] ${tool.name} failed: ${errorSummary(error)}`);
    return failResult('read_failed', READ_FAILED_MESSAGE_AR);
  }
}
