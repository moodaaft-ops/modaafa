import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { createAdminClient } from '@/lib/supabase/server';
import { getCustomer, getGoogleAdsErrorCodes } from '@/lib/google-ads/client';
import { assertNotManagerAccount } from '@/lib/google-ads/sync';
import { decrypt } from '@/lib/crypto';
import {
  decideOptimizations,
  checkGuardrails,
  executeAction,
  type ConversionTrackingStatus,
  type OptimizerSnapshot,
} from '@/lib/ai/optimizer-agent';
import { measureObservedImpacts } from '@/lib/ai/impact';
import {
  detectCampaignOpportunity,
  mapConvertingTermRows,
} from '@/lib/ai/opportunity';
import {
  getSectorBenchmark,
  refreshSectorBenchmarks,
  type SectorBenchmarkRow,
} from '@/lib/benchmarks/compute';
import {
  computeWeeklyComparison,
  generateWeeklyNarrative,
  type CampaignWeekRow,
} from '@/lib/ai/report-agent';
import { finishJobRun, getBillableBusinessIds, startJobRun } from '@/lib/platform/jobs';
import { sendOpsAlert } from '@/lib/notifications/email';
import { hasValidCronAuthorization } from '@/lib/security/cron-auth';
import { createTimeBudget, mapLimit } from '@/lib/platform/concurrency';
import {
  OPTIMIZE_ACCOUNT_CONCURRENCY,
  OPTIMIZE_ACCOUNT_LIMIT,
} from '@/lib/platform/job-capacity';

/**
 * Cron endpoint - runs hourly via Vercel Cron.
 *
 * Auth via CRON_SECRET header to prevent abuse.
 *
 * Process:
 * 1. List all active accounts
 * 2. For each: snapshot → decide → guardrail-check
 * 3. Queue recommendations for explicit owner approval and execution
 */
export const maxDuration = 300; // 5 min

/** Leave ~40s of the 300s budget for bookkeeping and ops alerts. */
const OPTIMIZE_BUDGET_MS = 260_000;
/**
 * Minimum budget left to ADMIT one more account. An account admitted with 1s
 * remaining could still spend ~60s on snapshot retries plus an Anthropic call
 * past the 300s hard kill — where `finishJobRun` never runs and the job_runs
 * row is stuck `running`. Sized to a realistic worst-case single account.
 */
const OPTIMIZE_PER_ACCOUNT_RESERVE_MS = 45_000;

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
  if (job.alreadyRunning) {
    // Overlapping optimize runs select the same oldest accounts and double
    // the Anthropic spend; refuse the second invocation honestly.
    return NextResponse.json({ skipped: 'already_running' }, { status: 409 });
  }

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
    .select('id, customer_id, customer_name, manager_id, currency_code, refresh_token_encrypted, business_id')
    .eq('status', 'active')
    .not('is_manager', 'is', true)
    .in('business_id', businessIds)
    .order('last_optimized_at', { ascending: true, nullsFirst: true })
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

  // Business context feeds the optimizer the way a real buyer is briefed:
  // sector, goal, and the owner's budget ceiling. Batched in one query.
  const businessContextById = new Map<string, { sector: string | null; primary_goal: string | null; monthly_budget: number | null }>();
  const businessIdsInBatch = Array.from(new Set(accounts.map((account) => account.business_id).filter(Boolean)));
  if (businessIdsInBatch.length > 0) {
    const { data: businessRows } = await supabase
      .from('businesses')
      .select('id, sector, primary_goal, monthly_budget')
      .in('id', businessIdsInBatch);
    for (const row of businessRows ?? []) {
      businessContextById.set(row.id, {
        sector: row.sector ?? null,
        primary_goal: row.primary_goal ?? null,
        monthly_budget: row.monthly_budget ?? null,
      });
    }
  }

  const results = {
    processed: 0,
    actions_executed: 0,
    recommendations_queued: 0,
    actions_blocked: 0,
    reports_generated: 0,
    impacts_measured: 0,
    opportunities_queued: 0,
    benchmarks_refreshed: 0,
    errors: [] as string[],
  };
  // One benchmark read per distinct (sector, currency) per run, not per account.
  const benchmarkCache = new Map<string, SectorBenchmarkRow | null>();
  // Launch policy: scheduled jobs only prepare recommendations. A signed-in
  // account owner must approve and explicitly execute every live mutation.
  const allowLiveExecution = false;
  const budget = createTimeBudget(OPTIMIZE_BUDGET_MS);
  let skippedForTime = 0;

  await mapLimit(accounts, OPTIMIZE_ACCOUNT_CONCURRENCY, async (account) => {
    if (budget.expired(OPTIMIZE_PER_ACCOUNT_RESERVE_MS)) {
      skippedForTime += 1;
      return;
    }

    try {
      const refreshToken = decrypt(account.refresh_token_encrypted);
      const customer = getCustomer(account.customer_id, refreshToken, account.manager_id ?? undefined);

      // Same hard guard the sync path runs: never fire metrics GAQL at a
      // manager account. The DB `is_manager` filter above is only as good as
      // the stored flag — a manager mis-recorded as `false` (a transient
      // metadata failure during discovery) otherwise ate 7 doomed metrics
      // queries here every hourly run until the SYNC cron happened to repair
      // it. The catch below writes the flag back, so this self-heals.
      await assertNotManagerAccount(customer);

      const businessContext = businessContextById.get(account.business_id) ?? null;

      // Sector benchmark for the "compare to your market" context.
      const benchmarkKey = `${businessContext?.sector ?? ''}|${account.currency_code ?? 'SAR'}`;
      if (!benchmarkCache.has(benchmarkKey)) {
        try {
          benchmarkCache.set(
            benchmarkKey,
            await getSectorBenchmark(supabase, businessContext?.sector, account.currency_code)
          );
        } catch (benchmarkError) {
          results.errors.push(
            `benchmark_lookup:${benchmarkKey}:${benchmarkError instanceof Error ? benchmarkError.message : benchmarkError}`
          );
          benchmarkCache.set(benchmarkKey, null);
        }
      }
      const sectorBenchmark = benchmarkCache.get(benchmarkKey) ?? null;

      // Build a focused snapshot for the optimizer
      const snapshot = await buildOptimizerSnapshot(
        customer,
        account.id,
        account.customer_id,
        account.currency_code ?? 'SAR',
        businessContext,
        sectorBenchmark
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
            // Include the terminal states, not just the active ones. A user who
            // DISMISSED a recommendation used to get the identical one re-queued
            // on the very next nightly run; an APPLIED non-idempotent action
            // (e.g. add_negative_keyword) could be re-approved into a duplicate.
            // `failed` is included too: re-queueing a pending twin of a failed
            // row meant re-approving the original later collided with the
            // fingerprint unique index and surfaced as `recommendation_locked`.
            .in('status', ['pending', 'approved', 'executing', 'applied', 'dismissed', 'failed'])
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

      // ---- Growth bridge: winning search terms that deserve a whole NEW
      // campaign become a recommendation whose CTA is the campaign builder.
      if (!budget.expired()) {
        try {
          const queued = await maybeQueueCampaignOpportunity({
            supabase,
            accountId: account.id,
            convertingTermRows: snapshot.converting_search_terms ?? [],
            currencyCode: account.currency_code ?? 'SAR',
          });
          if (queued) results.opportunities_queued++;
        } catch (opportunityError) {
          console.warn(`Campaign opportunity detection failed for ${account.customer_id}`, opportunityError);
        }
      }

      // ---- Learning loop: measure the real effect of past executed actions.
      if (!budget.expired()) {
        try {
          const impact = await measureObservedImpacts({ supabase, customer, accountId: account.id, limit: 5 });
          results.impacts_measured += impact.measured;
        } catch (impactError) {
          console.warn(`Observed-impact measurement failed for ${account.customer_id}`, impactError);
        }
      }

      // ---- Weekly intelligence report: once per Saudi week per account.
      if (!budget.expired()) {
        try {
          const generated = await maybeGenerateWeeklyReport({
            supabase,
            customer,
            accountId: account.id,
            customerName: account.customer_name ?? null,
            currencyCode: account.currency_code ?? 'SAR',
            businessContext: businessContextById.get(account.business_id) ?? null,
          });
          if (generated) results.reports_generated++;
        } catch (reportError) {
          console.warn(`Weekly report generation failed for ${account.customer_id}`, reportError);
        }
      }

      results.processed++;
    } catch (err) {
      // Self-heal the stored flag the moment Google (or our own pre-flight)
      // says this is a manager account, mirroring the sync cron. Without this
      // the same account failed every optimize run forever.
      if (getGoogleAdsErrorCodes(err).includes('REQUESTED_METRICS_FOR_MANAGER')) {
        const { error: managerFlagError } = await supabase
          .from('google_ads_accounts')
          .update({ is_manager: true })
          .eq('id', account.id);
        if (managerFlagError) {
          results.errors.push(`${account.customer_id}:manager_flag:${managerFlagError.message}`);
        }
      }
      results.errors.push(`${account.customer_id}: ${err instanceof Error ? err.message : err}`);
    } finally {
      const { error: cursorError } = await supabase
        .from('google_ads_accounts')
        .update({ last_optimized_at: new Date().toISOString() })
        .eq('id', account.id);
      if (cursorError) {
        results.errors.push(`${account.customer_id}:queue_cursor:${cursorError.message}`);
      }
    }
  });

  // ---- Sector benchmarks: recompute once per day from the campaign cache
  // (DB-only, no Google API calls; internally throttled to every 20h).
  if (!budget.expired()) {
    try {
      const refresh = await refreshSectorBenchmarks(supabase);
      if (refresh.refreshed) results.benchmarks_refreshed = refresh.rows;
    } catch (benchmarkError) {
      console.warn('Sector benchmark refresh failed', benchmarkError);
      results.errors.push(
        `benchmark_refresh:${benchmarkError instanceof Error ? benchmarkError.message : benchmarkError}`
      );
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
      reports_generated: results.reports_generated,
      impacts_measured: results.impacts_measured,
      opportunities_queued: results.opportunities_queued,
      benchmarks_refreshed: results.benchmarks_refreshed,
      live_execution_enabled: allowLiveExecution,
      // Never truncate silently: an operator reading job_runs must be able to
      // tell "covered everything" from "ran out of time".
      skipped_for_time: skippedForTime,
      batch_limit: OPTIMIZE_ACCOUNT_LIMIT,
      concurrency: OPTIMIZE_ACCOUNT_CONCURRENCY,
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
  currencyCode: string,
  businessContext: { sector: string | null; primary_goal: string | null; monthly_budget: number | null } | null,
  sectorBenchmark: SectorBenchmarkRow | null = null
): Promise<OptimizerSnapshot> {
  const [campaigns, highPerforming, underperforming, wastedTerms, convertingTerms, poorAds, enabledKeywords, adGroupBidTargets] =
    await Promise.all([
    // Bounded, highest-spend first. This and the underperforming query below
    // had no LIMIT: a large account could return thousands of rows, ballooning
    // the per-account prompt to hundreds of KB every hourly run (real token
    // cost, and request-too-large failures that aborted the account).
    customer.query(`
      SELECT
        campaign.id, campaign.name, campaign.resource_name,
        campaign_budget.id, campaign_budget.amount_micros, campaign_budget.resource_name,
        metrics.cost_micros, metrics.clicks, metrics.conversions, metrics.conversions_value
      FROM campaign
      WHERE segments.date DURING LAST_7_DAYS
        AND campaign.status = 'ENABLED'
      ORDER BY metrics.cost_micros DESC
      LIMIT 200
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
      ORDER BY metrics.cost_micros DESC
      LIMIT 100
    `),
    // campaign.resource_name is selected so add_negative_keyword can name the
    // campaign that actually served the term. Without it the model saw the
    // campaign list but no term→campaign mapping, and attached negatives to a
    // plausible-but-wrong campaign — a mistake every validation layer accepts,
    // because any same-account campaign is "valid".
    customer.query(`
      SELECT
        search_term_view.search_term,
        search_term_view.ad_group,
        campaign.resource_name,
        campaign.name,
        metrics.clicks, metrics.cost_micros
      FROM search_term_view
      WHERE segments.date DURING LAST_7_DAYS
        AND metrics.clicks > 5
        AND metrics.conversions = 0
      LIMIT 50
    `),
    // The EXPANSION pool: search terms that already convert but are not
    // keywords yet. Google only reports terms triggered by broad/phrase
    // matching here, so promoting one to EXACT is a pure win: same demand,
    // tighter control, its own quality score and bid.
    customer.query(`
      SELECT
        search_term_view.search_term,
        search_term_view.ad_group,
        search_term_view.status,
        campaign.resource_name,
        campaign.name,
        metrics.clicks, metrics.cost_micros,
        metrics.conversions, metrics.conversions_value
      FROM search_term_view
      WHERE segments.date DURING LAST_30_DAYS
        AND metrics.conversions >= 2
      ORDER BY metrics.conversions DESC
      LIMIT 30
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
    // Current ad-group bid targets — the data adjust_bid decisions anchor to.
    // Without this list the model had no current value to copy, the queue-time
    // ±20% guardrail failed closed (unknown current ⇒ blocked), and not one
    // bid recommendation ever reached the approval centre.
    customer.query(`
      SELECT
        ad_group.resource_name,
        ad_group.name,
        ad_group.campaign,
        ad_group.target_cpa_micros,
        ad_group.target_roas,
        metrics.conversions, metrics.cost_micros
      FROM ad_group
      WHERE segments.date DURING LAST_30_DAYS
        AND ad_group.status = 'ENABLED'
      ORDER BY metrics.cost_micros DESC
      LIMIT 50
    `).then((rows: any[]) =>
      rows.filter((row: any) => {
        const adGroup = row.adGroup ?? row.ad_group ?? {};
        const cpa = Number(adGroup.targetCpaMicros ?? adGroup.target_cpa_micros ?? 0);
        const roas = Number(adGroup.targetRoas ?? adGroup.target_roas ?? 0);
        return cpa > 0 || roas > 0;
      })
    ).catch(() => [] as any[]),
  ]);

  // ---- Conversion tracking health: the gate every other decision sits behind.
  let conversionTracking: OptimizerSnapshot['conversion_tracking'] = { status: 'unknown', enabled_actions: 0 };
  try {
    const conversionActions = await customer.query(`
      SELECT conversion_action.resource_name, conversion_action.status
      FROM conversion_action
      WHERE conversion_action.status = 'ENABLED'
      LIMIT 50
    `);
    const enabledActions = conversionActions.length;
    const clicks7 = campaigns.reduce(
      (total: number, row: any) => total + Number(row.metrics?.clicks ?? 0),
      0
    );
    const conversions7 = campaigns.reduce(
      (total: number, row: any) =>
        total + Number(row.metrics?.conversions ?? 0),
      0
    );
    const status: ConversionTrackingStatus =
      enabledActions === 0
        ? 'missing'
        : clicks7 >= 100 && conversions7 === 0
          ? 'suspect'
          : 'healthy';
    conversionTracking = {
      status,
      enabled_actions: enabledActions,
      ...(status === 'suspect'
        ? { note: 'Enabled conversion actions exist but real click volume produced zero conversions in 7 days.' }
        : {}),
    };
  } catch (error) {
    console.warn(`Conversion tracking check failed for ${customerId}`, error);
  }

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
    today: new Date().toISOString().slice(0, 10),
    business_context: businessContext,
    sector_benchmark: sectorBenchmark
      ? {
          sector: sectorBenchmark.sector,
          businesses_count: sectorBenchmark.businesses_count,
          median_cpa: sectorBenchmark.median_cpa,
          median_ctr: sectorBenchmark.median_ctr,
          median_roas: sectorBenchmark.median_roas,
        }
      : null,
    conversion_tracking: conversionTracking,
    campaigns,
    underperforming_keywords: underperforming,
    high_performing_keywords: highPerforming,
    wasted_search_terms: wastedTerms,
    converting_search_terms: convertingTerms,
    ad_group_bid_targets: adGroupBidTargets,
    budget_utilization: budgetUtilization,
    poor_ads: poorAds,
    keyword_count: enabledKeywords.length,
    currency_code: currencyCode,
    target_roas: totals.cost > 0 ? totals.value / totals.cost : 0,
    target_cpa: totals.conversions > 0 ? totals.cost / totals.conversions : 0,
  };
}

// ---------------------------------------------------------------------------
// Campaign opportunity (growth bridge to the builder)
// ---------------------------------------------------------------------------

const OPPORTUNITY_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Queue a "build a new campaign" recommendation when the converting-terms pool
 * justifies one. Deduped two ways: a stable fingerprint blocks a second ACTIVE
 * opportunity, and a 14-day cooldown (any status, including dismissed) stops
 * the platform from re-nagging an owner who said no.
 */
async function maybeQueueCampaignOpportunity({
  supabase,
  accountId,
  convertingTermRows,
  currencyCode,
}: {
  supabase: any;
  accountId: string;
  convertingTermRows: any[];
  currencyCode: string;
}): Promise<boolean> {
  const opportunity = detectCampaignOpportunity(mapConvertingTermRows(convertingTermRows), currencyCode);
  if (!opportunity) return false;

  const { data: recent } = await supabase
    .from('recommendations')
    .select('id')
    .eq('account_id', accountId)
    .gte('created_at', new Date(Date.now() - OPPORTUNITY_COOLDOWN_MS).toISOString())
    .contains('action_payload', { operation: 'build_campaign_opportunity' })
    .limit(1)
    .maybeSingle();
  if (recent) return false;

  const { error } = await supabase.from('recommendations').insert({
    account_id: accountId,
    fingerprint: createHash('sha256').update(`${accountId}:build_campaign_opportunity`).digest('hex'),
    category: 'structure',
    severity: opportunity.totals.conversions >= 15 ? 'medium' : 'growth',
    title: opportunity.title_ar.slice(0, 120),
    description: opportunity.description_ar,
    expected_impact: {
      metric: 'conversions',
      delta_pct: 15,
      delta_sar_per_month: Math.round(opportunity.totals.conversion_value * 0.15),
    },
    action_payload: {
      operation: 'build_campaign_opportunity',
      brief_ar: opportunity.brief_ar,
      terms: opportunity.terms,
      totals: opportunity.totals,
      source: 'optimizer_cron',
    },
    status: 'pending',
  });
  if (error) {
    if (error.code === '23505') return false; // an active opportunity already exists
    throw error;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Weekly intelligence report
// ---------------------------------------------------------------------------

/** Saturday 00:00 UTC — the Saudi work week, matching usageWindow('week'). */
function startOfSaudiWeekIso(now = new Date()) {
  const date = new Date(now);
  const daysSinceSaturday = (date.getUTCDay() + 1) % 7;
  date.setUTCDate(date.getUTCDate() - daysSinceSaturday);
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString();
}

function isoDay(date: Date) {
  return date.toISOString().slice(0, 10);
}

function mapWeekRows(rows: any[]): CampaignWeekRow[] {
  return (rows ?? []).map((row: any) => {
    const metrics = row.metrics ?? {};
    return {
      name: String(row.campaign?.name ?? row.campaign?.id ?? 'حملة'),
      cost: Number(metrics.costMicros ?? metrics.cost_micros ?? 0) / 1_000_000,
      clicks: Number(metrics.clicks ?? 0),
      conversions: Number(metrics.conversions ?? 0),
      conversion_value: Number(metrics.conversionsValue ?? metrics.conversions_value ?? 0),
    };
  });
}

/**
 * Generate the week-over-week performance report once per Saudi week per
 * account. Deterministic math + model narrative; deduped via
 * metrics.kind = 'weekly_performance' within the current week.
 */
async function maybeGenerateWeeklyReport({
  supabase,
  customer,
  accountId,
  customerName,
  currencyCode,
  businessContext,
}: {
  supabase: any;
  customer: any;
  accountId: string;
  customerName: string | null;
  currencyCode: string;
  businessContext: { sector: string | null; primary_goal: string | null; monthly_budget: number | null } | null;
}): Promise<boolean> {
  const weekStart = startOfSaudiWeekIso();
  const { data: existing } = await supabase
    .from('reports')
    .select('id')
    .eq('account_id', accountId)
    .gte('generated_at', weekStart)
    .contains('metrics', { kind: 'weekly_performance' })
    .limit(1)
    .maybeSingle();
  if (existing) return false;

  const now = new Date();
  const priorStart = new Date(now);
  priorStart.setUTCDate(priorStart.getUTCDate() - 14);
  const priorEnd = new Date(now);
  priorEnd.setUTCDate(priorEnd.getUTCDate() - 8);

  const [thisWeekRows, priorWeekRows] = await Promise.all([
    customer.query(`
      SELECT campaign.id, campaign.name, metrics.cost_micros, metrics.clicks, metrics.conversions, metrics.conversions_value
      FROM campaign
      WHERE segments.date DURING LAST_7_DAYS
        AND metrics.impressions > 0
    `),
    customer.query(`
      SELECT campaign.id, campaign.name, metrics.cost_micros, metrics.clicks, metrics.conversions, metrics.conversions_value
      FROM campaign
      WHERE segments.date BETWEEN '${isoDay(priorStart)}' AND '${isoDay(priorEnd)}'
        AND metrics.impressions > 0
    `),
  ]);

  const comparison = computeWeeklyComparison(mapWeekRows(thisWeekRows), mapWeekRows(priorWeekRows));
  // A dead account (no delivery either week) does not deserve a noise report.
  if (comparison.totals.this_week.cost === 0 && comparison.totals.prior_week.cost === 0) return false;

  const narrative = await generateWeeklyNarrative(comparison, {
    customer_name: customerName,
    currency_code: currencyCode,
    sector: businessContext?.sector ?? null,
    primary_goal: businessContext?.primary_goal ?? null,
  });

  const { error } = await supabase.from('reports').insert({
    account_id: accountId,
    period_type: 'weekly',
    period_start: isoDay(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)),
    period_end: isoDay(now),
    summary_ar: narrative.summary_ar,
    metrics: {
      kind: 'weekly_performance',
      generated_by: narrative.generated_by,
      currency_code: currencyCode,
      totals: comparison.totals,
      movers: comparison.movers,
      highlights_ar: narrative.highlights_ar,
      next_week_ar: narrative.next_week_ar,
    },
  });
  if (error) {
    // Two overlapping runs can race past the read-check above; the unique
    // weekly-report index (migration 20260803) turns the loser into a 23505,
    // which simply means the report already exists.
    if ((error as { code?: string }).code === '23505') return false;
    throw error;
  }
  return true;
}

function actionFingerprint(accountId: string, action: any) {
  // Fingerprint the STABLE identity of the change only. Hashing the whole
  // action folded in `reason_ar`/`reason_en`/`expected_impact`, which the model
  // regenerates with different wording and rounding every night — so the hash
  // changed each run, the dedupe select missed, and the user accumulated one
  // near-identical pending recommendation per night per finding.
  const identity = {
    type: action?.type ?? null,
    target_id: action?.target_id ?? null,
    params: action?.params ?? {},
  };
  return createHash('sha256')
    .update(`${accountId}:${stableStringify(identity)}`)
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
    add_keyword: 'keywords',
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
