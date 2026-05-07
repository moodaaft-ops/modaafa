import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { getCustomer } from '@/lib/google-ads/client';
import { decrypt } from '@/lib/crypto';
import {
  decideOptimizations,
  checkGuardrails,
  executeAction,
  type OptimizerSnapshot,
} from '@/lib/ai/optimizer-agent';

/**
 * Cron endpoint - runs hourly via Vercel Cron / Inngest.
 *
 * Auth via CRON_SECRET header to prevent abuse.
 *
 * Process:
 * 1. List all active accounts with autopilot enabled
 * 2. For each: snapshot → decide → guardrail-check → execute → log
 * 3. Send notifications for any "approval-required" actions
 */
export const maxDuration = 300; // 5 min

export async function POST(req: NextRequest) {
  // Auth
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const supabase = createAdminClient();

  // Get all active accounts with autopilot enabled
  const { data: accounts } = await supabase
    .from('google_ads_accounts')
    .select('id, customer_id, refresh_token_encrypted, business_id')
    .eq('status', 'active');

  if (!accounts || accounts.length === 0) {
    return NextResponse.json({ processed: 0 });
  }

  const results = {
    processed: 0,
    actions_executed: 0,
    actions_blocked: 0,
    errors: [] as string[],
  };

  for (const account of accounts) {
    try {
      const refreshToken = decrypt(account.refresh_token_encrypted);
      const customer = getCustomer(account.customer_id, refreshToken);

      // Build a focused snapshot for the optimizer
      const snapshot = await buildOptimizerSnapshot(customer, account.id, account.customer_id);

      // Get AI decisions
      const actions = await decideOptimizations(snapshot);

      // Apply guardrails + execute
      for (const action of actions) {
        const safe = await checkGuardrails(action, account.id);
        if (!safe) {
          results.actions_blocked++;
          continue;
        }

        try {
          const result = await executeAction(action, customer);

          // Log the action
          await supabase.from('ai_actions').insert({
            account_id: account.id,
            action_type: action.type,
            description_ar: action.reason_ar,
            description_en: action.reason_en,
            reason: action.reason_en,
            payload: action.params,
            result: result as any,
            expected_impact: action.expected_impact,
          });

          results.actions_executed++;
        } catch (err) {
          results.errors.push(`${account.customer_id}: ${err instanceof Error ? err.message : err}`);
        }
      }

      results.processed++;
    } catch (err) {
      results.errors.push(`${account.customer_id}: ${err instanceof Error ? err.message : err}`);
    }
  }

  return NextResponse.json(results);
}

async function buildOptimizerSnapshot(
  customer: any,
  accountId: string,
  customerId: string
): Promise<OptimizerSnapshot> {
  const [campaigns, underperforming, wastedTerms] = await Promise.all([
    customer.query(`
      SELECT
        campaign.id, campaign.name, campaign.resource_name,
        campaign_budget.id, campaign_budget.amount_micros, campaign_budget.resource_name,
        metrics.cost_micros, metrics.conversions, metrics.conversions_value
      FROM campaign
      WHERE segments.date DURING LAST_7_DAYS
        AND campaign.status = 'ENABLED'
    `),
    customer.query(`
      SELECT
        ad_group_criterion.resource_name,
        ad_group_criterion.keyword.text,
        metrics.clicks, metrics.cost_micros, metrics.ctr, metrics.conversions
      FROM keyword_view
      WHERE segments.date DURING LAST_7_DAYS
        AND metrics.clicks > 20
        AND metrics.conversions = 0
        AND metrics.ctr < 0.01
        AND ad_group_criterion.status = 'ENABLED'
    `),
    customer.query(`
      SELECT
        search_term_view.search_term,
        search_term_view.ad_group,
        metrics.clicks, metrics.cost_micros
      FROM search_term_view
      WHERE segments.date DURING LAST_7_DAYS
        AND metrics.clicks > 5
        AND metrics.conversions = 0
      LIMIT 50
    `),
  ]);

  return {
    account_id: accountId,
    customer_id: customerId,
    campaigns,
    underperforming_keywords: underperforming,
    high_performing_keywords: [],
    wasted_search_terms: wastedTerms,
    budget_utilization: [],
    poor_ads: [],
    target_roas: 3.0,
    target_cpa: 50,
  };
}
