import type Anthropic from '@anthropic-ai/sdk';
import { getAnthropicClient, getModelForAgent } from './client';
import type { Customer } from 'google-ads-api';

/**
 * Campaign Builder Agent
 *
 * The user types something like:
 *   "أبغى حملة لمنتج عطر رجالي بميزانية ٣٠٠٠ ر.س — استهدف الرياض وجدة"
 *
 * The agent uses Claude with tool use to:
 * 1. Discover relevant keywords (KeywordPlanIdeaService)
 * 2. Forecast metrics
 * 3. Generate Arabic ad copies
 * 4. Build a complete campaign draft (no API write yet — user must approve)
 */

const anthropic = getAnthropicClient();
const MODEL = getModelForAgent('builder'); // Opus 4.7 - creative campaign generation

const SYSTEM_PROMPT = `You are a senior Google Ads strategist building campaigns for advertisers in the Saudi/Gulf market.

PROCESS
1. Read the user's brief (Arabic or English).
2. Use the available tools to gather data: keyword ideas, location codes, metric forecasts.
3. Build a complete campaign draft.
4. Return a structured plan in JSON. NEVER auto-launch — the user must explicitly approve.

OUTPUT (after tool calls)
{
  "draft_campaign": {
    "name": "...",
    "type": "SEARCH" | "PMAX" | "DISPLAY" | "SHOPPING" | "VIDEO",
    "daily_budget_sar": number,
    "bidding_strategy": "MAXIMIZE_CONVERSIONS" | "TARGET_ROAS" | "TARGET_CPA",
    "geo_targets": [{ "country": "SA", "regions": [...] }],
    "language": "ar",
    "ad_groups": [
      {
        "name": "...",
        "keywords": [{ "text": "...", "match_type": "EXACT|PHRASE|BROAD" }],
        "headlines_ar": ["..."],
        "descriptions_ar": ["..."]
      }
    ],
    "forecast": {
      "expected_clicks": number,
      "expected_conversions": number,
      "expected_cpa_sar": number,
      "expected_roas": number
    }
  },
  "summary_ar": "ملخص للعميل بالعربي",
  "next_steps_ar": ["خطوات يحتاج العميل يأكدها قبل الإطلاق"]
}

QUALITY GUIDELINES
- 3-5 ad groups, 8-15 keywords each
- 3+ headlines (max 30 chars Arabic each), 2+ descriptions (max 90 chars)
- Headlines must include benefit + CTA + brand differentiator
- Use natural Saudi/Gulf phrasing (e.g. "أصلي", "شحن مجاني", "ضمان")
- Daily budget = monthly_budget / 30
- For Saudi market, default geo = SA + relevant cities`;

const TOOLS = [
  {
    name: 'get_keyword_ideas',
    description: 'Get keyword ideas with search volume and competition for a seed keyword.',
    input_schema: {
      type: 'object',
      properties: {
        seed: { type: 'string', description: 'Seed keyword in Arabic or English' },
        country_code: { type: 'string', description: 'ISO country, e.g. "SA"', default: 'SA' },
        language: { type: 'string', enum: ['ar', 'en'], default: 'ar' },
      },
      required: ['seed'],
    },
  },
  {
    name: 'forecast_campaign',
    description: 'Estimate clicks/conversions/cost for a campaign with these keywords and budget.',
    input_schema: {
      type: 'object',
      properties: {
        keywords: { type: 'array', items: { type: 'string' } },
        daily_budget_sar: { type: 'number' },
        country_code: { type: 'string', default: 'SA' },
      },
      required: ['keywords', 'daily_budget_sar'],
    },
  },
  {
    name: 'finalize_draft',
    description: 'Output the final campaign draft for user review.',
    input_schema: {
      type: 'object',
      properties: {
        draft: { type: 'object' },
        summary_ar: { type: 'string' },
      },
      required: ['draft', 'summary_ar'],
    },
  },
] as const;

export interface BuilderResult {
  draft_campaign: any;
  summary_ar: string;
  next_steps_ar: string[];
  tool_trace: Array<{ tool: string; input: any; output: any }>;
}

export async function buildCampaign(
  brief: string,
  customer: Customer,
  context?: { business_name?: string; sector?: string; website?: string }
): Promise<BuilderResult> {
  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: `Customer brief: ${brief}\n\nBusiness context: ${JSON.stringify(context ?? {})}`,
    },
  ];

  const toolTrace: Array<{ tool: string; input: any; output: any }> = [];
  let finalDraft: any = null;

  // Tool-use loop (max 10 turns)
  for (let i = 0; i < 10; i++) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: TOOLS as any,
      messages,
    });

    if (response.stop_reason === 'end_turn') break;

    if (response.stop_reason === 'tool_use') {
      const assistantContent = response.content;
      messages.push({ role: 'assistant', content: assistantContent });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of assistantContent) {
        if (block.type !== 'tool_use') continue;

        let output: any;
        try {
          output = await runTool(block.name, block.input as any, customer);
          toolTrace.push({ tool: block.name, input: block.input, output });

          if (block.name === 'finalize_draft') {
            finalDraft = block.input;
          }
        } catch (err) {
          output = { error: err instanceof Error ? err.message : String(err) };
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(output),
        });
      }

      messages.push({ role: 'user', content: toolResults });

      if (finalDraft) break;
    }
  }

  return {
    draft_campaign: finalDraft?.draft ?? {},
    summary_ar: finalDraft?.summary_ar ?? '',
    next_steps_ar: finalDraft?.next_steps_ar ?? [],
    tool_trace: toolTrace,
  };
}

async function runTool(name: string, input: any, customer: Customer): Promise<any> {
  switch (name) {
    case 'get_keyword_ideas': {
      // Real implementation: KeywordPlanIdeaService
      // For brevity, simplified call
      try {
        const result = await customer.keywordPlanIdeas.generateKeywordIdeas({
          customer_id: (customer as any).credentials.customer_id,
          language: 'languageConstants/1019', // Arabic
          geo_target_constants: [`geoTargetConstants/2682`], // Saudi Arabia
          keyword_seed: { keywords: [input.seed] },
        } as any);
        return result.slice(0, 30).map((r: any) => ({
          text: r.text,
          avg_monthly_searches: r.keyword_idea_metrics?.avg_monthly_searches,
          competition: r.keyword_idea_metrics?.competition,
          low_top_of_page_bid: r.keyword_idea_metrics?.low_top_of_page_bid_micros,
          high_top_of_page_bid: r.keyword_idea_metrics?.high_top_of_page_bid_micros,
        }));
      } catch (err) {
        return { error: 'keyword_planning_unavailable', message: String(err) };
      }
    }

    case 'forecast_campaign': {
      // Simplified forecast - real impl uses KeywordPlanService.generateForecastMetrics
      const { daily_budget_sar, keywords } = input;
      const monthly = daily_budget_sar * 30;
      const avgCpc = 4.5;
      const expectedClicks = Math.round(monthly / avgCpc);
      const expectedConvRate = 0.025;
      const expectedConversions = Math.round(expectedClicks * expectedConvRate);
      const expectedCPA = monthly / Math.max(1, expectedConversions);
      return {
        expected_clicks: expectedClicks,
        expected_conversions: expectedConversions,
        expected_cpa_sar: Math.round(expectedCPA),
        expected_roas: 3.5, // illustrative
      };
    }

    case 'finalize_draft':
      return { ok: true };
  }
  return null;
}
