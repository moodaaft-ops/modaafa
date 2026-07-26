import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { createAdminClient } from '@/lib/supabase/server';
import { getCustomer } from '@/lib/google-ads/client';
import { decrypt } from '@/lib/crypto';
import {
  decideOptimizations,
  checkGuardrails,
  executeAction,
  type OptimizerSnapshot,
} from '@/lib/ai/optimizer-agent';
import { finishJobRun, getBillableBusinessIds, startJobRun } from '@/lib/platform/jobs';
import { sendOpsAlert } from '@/lib/notifications/email';
import { hasValidCronAuthorization } from '@/lib/security/cron-auth';
import { createTimeBudget } from '@/lib/platform/concurrency';

/**
 * Cron endpoint - runs daily via Vercel Cron.
 *
 * Auth via CRON_SECRET header to prevent abuse.
 *
 * Process:
 * 1. List all active accounts
 * 2. For each: snapshot → decide → guardrail-check
 * 3. Queue recommendations by default; execute only when ENABLE_AUTOPILOT_EXECUTION=true
 */
export const maxDuration = 300; // 5 min

/** Round-robin batch size; the rest are picked up on the next run. */
const OPTIMIZE_ACCOUNT_LIMIT = 25;
/** Leave ~40s of the 300s budget for bookkeeping and ops alerts. */
const OPTIMIZE_BUDGET_MS = 260_000;

async function runOptimizerCron(req: NextRequest) {
  // Auth
  if (!hasValidCronAuthorization(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let supabase;
  try {
    supabase = createAdminClient();
  } catch (error) {
    return NextResponse.json(
      { error: 'service_role_missing', message: error instanceof Error ? error.message : String(error) },
      { status: 503 }
    );
  }

  const job = await startJobRun(supabase, 'optimize');

  let businessIds: string[];
  try {
    businessIds = await getBillableBusinessIds(supabase);
  } catch (error) {
    await finishJobRun({ supabase, job, status: 'failed', errors: [error] });
    await safeOpsAlert('تعذر تحديد الاشتراكات النشطة للتحسين', error);
    return NextResponse.json({ error: 'subscription_lookup_failed' }, { status: 500 });
  }

  if (businessIds.length === 0) {
    await finishJobRun({
      supabase,
      job,
      status: 'success',
      details: { note: 'No billable businesses found' },
    });
    return NextResponse.json({ processed: 0, skipped: 'no_billable_businesses' });
  }

  // Get active accounts. Live execution is intentionally opt-in.
  //
  // Bounded and round-robin ordered: this used to select EVERY active account
  // with no limit and loop serially doing 6 metrics queries plus an LLM call
  // each, inside a 300s function. Past ~20 accounts the job was killed
  // mid-loop, `finishJobRun` never ran, and because the ordering was unstable
  // it was the same accounts that got skipped every night.
  const { data: accounts, error: accountLookupError } = await supabase
    .from('google_ads_accounts')
    .select('id, customer_id, manager_id, currency_code, refresh_token_encrypted, business_id')
    .eq('status', 'active')
    .not('is_manager', 'is', true)
    .in('business_id', businessIds)
    .order('last_synced_at', { ascending: true, nullsFirst: true })
    .limit(OPTIMIZE_ACCOUNT_LIMIT);

  if (accountLookupError) {
    await finishJobRun({ supabase, job, status: 'failed', errors: [accountLookupError] });
    await safeOpsAlert('فشل جلب حسابات مهمة التحسين', accountLookupError);
    return NextResponse.json({ error: 'account_lookup_failed' }, { status: 500 });
  }

  if (!accounts || accounts.length === 0) {
    await finishJobRun({ supabase, job, status: 'success', details: { note: 'No active accounts found' } });
    return NextResponse.json({ processed: 0 });
  }

  const results = {
    processed: 0,
    actions_executed: 0,
    recommendations_queued: 0,
    actions_blocked: 0,
    errors: [] as string[],
  };
  // Launch policy: scheduled jobs only prepare recommendations. A signed-in
  // account owner must approve and explicitly execute every live mutation.
  const allowLiveExecution = false;
  const budget = createTimeBudget(OPTIMIZE_BUDGET_MS);
  let skippedForTime = 0;

  for (const account of accounts) {
    if (budget.expired()) {
      skippedForTime += 1;
      continue;
    }

    try {
      const refreshToken = decrypt(account.refresh_token_encrypted);
      const customer = getCustomer(account.customer_id, refreshToken, account.manager_id ?? undefined);

      // Build a focused snapshot for the optimizer
      const snapshot = await buildOptimizerSnapshot(
        customer,
        account.id,
        account.customer_id,
        account.currency_code ?? 'SAR'
      );

      // Get AI decisions
      const actions = await decideOptimizations(snapshot);

      // Apply guardrails + execute
      const maxKeywordPauses = Math.floor(snapshot.keyword_count * 0.2);
      let keywordPauses = 0;
      for (const action of actions.slice(0, 8)) {
        if (action.type === 'pause_keyword') {
          if (keywordPauses >= maxKeywordPauses) {
            results.actions_blocked++;
            continue;
          }
          keywordPauses++;
        }
        const safe = await checkGuardrails(action, account.id, supabase);
        if (!safe) {
          results.actions_blocked++;
          continue;
        }

        if (!allowLiveExecution) {
          const fingerprint = actionFingerprint(account.id, action);
          const { data: existing } = await supabase
            .from('recommendations')
            .select('id')
            .eq('account_id', account.id)
            .eq('fingerprint', fingerprint)
            .in('status', ['pending', 'approved', 'executing'])
            .maybeSingle();
          if (existing) continue;

          const { error: insertError } = await supabase.from('recommendations').insert({
            account_id: account.id,
            fingerprint,
            category: categoryForAction(action.type),
            severity: severityForAction(action),
            title: action.reason_ar.slice(0, 120),
            description: action.reason_ar,
            expected_impact: action.expected_impact,
            action_payload: {
              operation: action.type,
              target_id: action.target_id,
              params: action.params,
              source: 'optimizer_cron',
            },
            status: 'pending',
          });
          if (insertError) {
            if (insertError.code === '23505') continue;
            throw insertError;
          }
          results.recommendations_queued++;
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

  const status = results.errors.length === 0 ? 'success' : results.processed > 0 ? 'partial' : 'failed';
  await finishJobRun({
    supabase,
    job,
    status,
    processed: results.processed,
    errors: results.errors,
    details: {
      actions_executed: results.actions_executed,
      recommendations_queued: results.recommendations_queued,
      actions_blocked: results.actions_blocked,
      live_execution_enabled: allowLiveExecution,
      // Never truncate silently: an operator reading job_runs must be able to
      // tell "covered everything" from "ran out of time".
      skipped_for_time: skippedForTime,
      batch_limit: OPTIMIZE_ACCOUNT_LIMIT,
    },
  });
  if (results.errors.length > 0) {
    await safeOpsAlert('مهمة تحسين Google Ads انتهت بأخطاء', results.errors);
  }

  return NextResponse.json(results);
}

async function safeOpsAlert(subject: string, details: unknown) {
  try {
    await sendOpsAlert({
      subject,
      message: 'راجع سجل المهام في Supabase وسجلات Vercel لمعرفة الحسابات المتأثرة.',
      details,
    });
  } catch (error) {
    console.error('Failed to send optimizer cron alert', error);
  }
}

export async function GET(req: NextRequest) {
  return runOptimizerCron(req);
}

export async function POST(req: NextRequest) {
  return runOptimizerCron(req);
}

async function buildOptimizerSnapshot(
  customer: any,
  accountId: string,
  customerId: string,
  currencyCode: string
): Promise<OptimizerSnapshot> {
  const [campaigns, highPerforming, underperforming, wastedTerms, poorAds, enabledKeywords] = await Promise.all([
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
        metrics.clicks, metrics.cost_micros, metrics.ctr,
        metrics.conversions, metrics.conversions_value
      FROM keyword_view
      WHERE segments.date DURING LAST_30_DAYS
        AND metrics.conversions > 0
        AND ad_group_criterion.status = 'ENABLED'
      ORDER BY metrics.conversions_value DESC
      LIMIT 100
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
    customer.query(`
      SELECT
        ad_group_ad.resource_name,
        ad_group_ad.ad.id,
        ad_group_ad.ad_strength,
        metrics.ctr,
        metrics.impressions
      FROM ad_group_ad
      WHERE segments.date DURING LAST_30_DAYS
        AND ad_group_ad.status = 'ENABLED'
        AND metrics.impressions >= 100
      ORDER BY metrics.ctr ASC
      LIMIT 100
    `),
    customer.query(`
      SELECT ad_group_criterion.resource_name
      FROM keyword_view
      WHERE ad_group_criterion.status = 'ENABLED'
      LIMIT 10000
    `),
  ]);

  const totals = campaigns.reduce(
    (acc: { cost: number; conversions: number; value: number }, row: any) => {
      const metrics = row.metrics ?? {};
      acc.cost += Number(metrics.costMicros ?? metrics.cost_micros ?? 0) / 1_000_000;
      acc.conversions += Number(metrics.conversions ?? 0);
      acc.value += Number(metrics.conversionsValue ?? metrics.conversions_value ?? 0);
      return acc;
    },
    { cost: 0, conversions: 0, value: 0 }
  );

  const budgetUtilization = campaigns.map((row: any) => {
    const metrics = row.metrics ?? {};
    const budget = row.campaignBudget ?? row.campaign_budget ?? {};
    const weeklyBudget = (Number(budget.amountMicros ?? budget.amount_micros ?? 0) / 1_000_000) * 7;
    const spend = Number(metrics.costMicros ?? metrics.cost_micros ?? 0) / 1_000_000;
    return {
      campaign: row.campaign,
      campaign_budget: budget,
      spend_7d: spend,
      utilization: weeklyBudget > 0 ? spend / weeklyBudget : 0,
    };
  });

  return {
    account_id: accountId,
    customer_id: customerId,
    campaigns,
    underperforming_keywords: underperforming,
    high_performing_keywords: highPerforming,
    wasted_search_terms: wastedTerms,
    budget_utilization: budgetUtilization,
    poor_ads: poorAds,
    keyword_count: enabledKeywords.length,
    currency_code: currencyCode,
    target_roas: totals.cost > 0 ? totals.value / totals.cost : 0,
    target_cpa: totals.conversions > 0 ? totals.cost / totals.conversions : 0,
  };
}

function actionFingerprint(accountId: string, action: unknown) {
  return createHash('sha256')
    .update(`${accountId}:${stableStringify(action)}`)
    .digest('hex');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function categoryForAction(type: string) {
  const map: Record<string, string> = {
    pause_keyword: 'keywords',
    add_negative_keyword: 'keywords',
    adjust_budget: 'budget',
    adjust_bid: 'bidding',
    pause_ad: 'ads',
  };
  return map[type] ?? 'structure';
}

function severityForAction(action: { expected_impact?: { delta_sar_per_month?: number } }) {
  const impact = Number(action.expected_impact?.delta_sar_per_month ?? 0);
  if (impact >= 1000) return 'critical';
  if (impact >= 250) return 'medium';
  return 'growth';
}
