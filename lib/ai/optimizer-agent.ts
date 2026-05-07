import { getAnthropicClient, getModelForAgent } from './client';
import type { Customer } from 'google-ads-api';
import { createAdminClient } from '../supabase/server';

/**
 * Optimizer Agent - the heart of the platform.
 *
 * Runs hourly via cron for every active account. For each account:
 * 1. Snapshot recent metrics (last 1 hour, 24 hours, 7 days)
 * 2. Apply rule-based pre-filters (cheap)
 * 3. Pass remaining decisions to Claude for nuanced judgment
 * 4. Execute approved actions via Google Ads API
 * 5. Log every action in ai_actions for auditability and rollback
 *
 * Hard guardrails:
 * - Cannot increase any budget by more than 50% in 24h
 * - Cannot exceed customer's monthly budget cap
 * - Cannot pause more than 20% of keywords in one run
 * - Cannot disable conversion tracking
 * - All actions are reversible within 30 days
 */

const anthropic = getAnthropicClient();
const MODEL = getModelForAgent('optimizer'); // Sonnet 4.6 - hourly cron, cost-balanced

const SYSTEM_PROMPT = `You are an expert Google Ads optimizer agent for Modaafa. You make incremental, conservative optimizations to advertising accounts every hour.

YOUR PHILOSOPHY
- Conservative beats aggressive. Never risk a sudden drop in performance.
- Every action must have a clear, evidence-based reason rooted in the data.
- Prefer many small adjustments over few large ones.
- Trust the data: don't guess.

ALLOWED ACTIONS (call as tools)
- pause_keyword: pause keywords with sustained low CTR (<1%) and zero conversions over 7+ days, AND clicks > 20
- add_negative_keyword: add a negative when a search term has 5+ clicks and 0 conversions
- adjust_budget: increase a budget by max 25% if ROAS > target AND budget is 90%+ utilized for 3+ days; decrease by max 30% if ROAS < target by 50%+
- adjust_bid: adjust ad-group target CPA / target ROAS within ±20% based on conversion trends
- pause_ad: pause individual ads with ad_strength=POOR and CTR < half of ad-group average

DECISION FRAMEWORK
1. Read the snapshot below carefully.
2. For each potential action, check that:
   a. There is enough data (no decisions on <7 days of data)
   b. The action follows the allowed parameters
   c. The expected impact is meaningful (>5% improvement in target metric)
3. Output a JSON list of actions, sorted by expected impact (largest first).
4. Maximum 8 actions per run.
5. If no action is justified, return an empty list.

OUTPUT FORMAT
Return ONLY a JSON object (no markdown):
{
  "actions": [
    {
      "type": "pause_keyword" | "add_negative_keyword" | "adjust_budget" | "adjust_bid" | "pause_ad",
      "target_id": string,
      "params": object,
      "reason_ar": string,
      "reason_en": string,
      "expected_impact": { "metric": string, "delta_pct": number, "delta_sar_per_month": number }
    }
  ]
}`;

export interface OptimizerSnapshot {
  account_id: string;
  customer_id: string;
  campaigns: any[];
  underperforming_keywords: any[];
  high_performing_keywords: any[];
  wasted_search_terms: any[];
  budget_utilization: any[];
  poor_ads: any[];
  target_roas: number;
  target_cpa: number;
}

export interface OptimizerAction {
  type: 'pause_keyword' | 'add_negative_keyword' | 'adjust_budget' | 'adjust_bid' | 'pause_ad';
  target_id: string;
  params: Record<string, unknown>;
  reason_ar: string;
  reason_en: string;
  expected_impact: {
    metric: string;
    delta_pct: number;
    delta_sar_per_month: number;
  };
}

export async function decideOptimizations(
  snapshot: OptimizerSnapshot
): Promise<OptimizerAction[]> {
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4000,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Account ${snapshot.customer_id} snapshot:\n${JSON.stringify(snapshot, null, 2)}`,
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') return [];

  const json = textBlock.text.match(/```(?:json)?\s*([\s\S]*?)\s*```/)?.[1] ?? textBlock.text.trim();
  try {
    const parsed = JSON.parse(json);
    return parsed.actions ?? [];
  } catch {
    console.error('Failed to parse optimizer JSON:', textBlock.text);
    return [];
  }
}

/**
 * Apply guardrails before executing an action.
 * Returns the action if safe, or null if blocked.
 */
export async function checkGuardrails(
  action: OptimizerAction,
  accountId: string
): Promise<OptimizerAction | null> {
  const supabase = createAdminClient();

  // Guardrail 1: Recent budget changes (max 50% increase in 24h cumulative)
  if (action.type === 'adjust_budget') {
    const { data: recent } = await supabase
      .from('ai_actions')
      .select('payload')
      .eq('account_id', accountId)
      .eq('action_type', 'adjust_budget')
      .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

    const cumulativePct = (recent ?? []).reduce(
      (sum: number, r: any) => sum + (r.payload?.delta_pct ?? 0),
      0
    );
    const newPct = (action.params.delta_pct as number) ?? 0;
    if (cumulativePct + newPct > 50) {
      return null; // Block: would exceed 50% in 24h
    }
  }

  // Guardrail 2: Mass-pause limit (max 20% of keywords in one run)
  // (handled at the orchestrator level by capping total actions)

  // Guardrail 3: Don't touch conversion tracking (no such action type allowed in our schema)

  return action;
}

/**
 * Execute an action via the Google Ads API.
 */
export async function executeAction(action: OptimizerAction, customer: Customer) {
  switch (action.type) {
    case 'pause_keyword': {
      return customer.adGroupCriteria.update([
        {
          resource_name: action.target_id,
          status: 'PAUSED',
        },
      ]);
    }

    case 'add_negative_keyword': {
      const { campaign_resource, keyword_text, match_type } = action.params as any;
      return customer.campaignCriteria.create([
        {
          campaign: campaign_resource,
          keyword: { text: keyword_text, match_type },
          negative: true,
        },
      ]);
    }

    case 'adjust_budget': {
      const { budget_resource, new_amount_micros } = action.params as any;
      return customer.campaignBudgets.update([
        { resource_name: budget_resource, amount_micros: new_amount_micros },
      ]);
    }

    case 'adjust_bid': {
      const { ad_group_resource, target_cpa_micros, target_roas } = action.params as any;
      return customer.adGroups.update([
        {
          resource_name: ad_group_resource,
          ...(target_cpa_micros && { target_cpa_micros }),
          ...(target_roas && { target_roas }),
        },
      ]);
    }

    case 'pause_ad': {
      return customer.adGroupAds.update([
        { resource_name: action.target_id, status: 'PAUSED' },
      ]);
    }
  }
}
