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
import { isExtendedActionsEnabled } from '@/lib/ai/extended-actions/flag';

export type { EvidenceKind, EvidenceRow, GaqlCustomer, JarvisReadTool, ToolContext, ToolResult } from './types';
export { conversionVerdict } from './get-conversion-health';

export const JARVIS_READ_TOOLS: readonly JarvisReadTool[] = [
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
  ...(isExtendedActionsEnabled() ? [getGoogleRecommendationsTool] : []),
];

const TOOLS_BY_NAME: ReadonlyMap<string, JarvisReadTool> = new Map(
  JARVIS_READ_TOOLS.map((tool) => [tool.name, tool])
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
