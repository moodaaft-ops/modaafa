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
import { getNgramAnalysisTool } from './get-ngram-analysis';
import { getAuctionInsightsTool } from './get-auction-insights';
import { getQualityScoreTool } from './get-quality-score';
import { isMonthlyReviewEnabled, isNgramEnabled } from '@/lib/loops/flags';

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

export const JARVIS_READ_TOOLS: readonly JarvisReadTool[] = [...BASE_READ_TOOLS, ...LOOP_READ_TOOLS];

const TOOLS_BY_NAME: ReadonlyMap<string, JarvisReadTool> = new Map(
  [...BASE_READ_TOOLS, getNgramAnalysisTool, getAuctionInsightsTool, getQualityScoreTool].map((tool) => [tool.name, tool])
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
