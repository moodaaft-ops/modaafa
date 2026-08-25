import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { createAdminClient } from '@/lib/supabase/server';
import { getCustomer, getGoogleAdsErrorCodes } from '@/lib/google-ads/client';
import { assertNotManagerAccount } from '@/lib/google-ads/sync';
import { decrypt } from '@/lib/crypto';
import {
  decideOptimizations,
  checkGuardrails,
  type ConversionTrackingStatus,
  type OptimizerSnapshot,
} from '@/lib/ai/optimizer-agent';
import { consumeFeatureUsage } from '@/lib/billing/entitlements';
import { executeAutopilotAction } from '@/lib/autopilot/executor';
import { findBlockingAutopilotRecommendation } from '@/lib/autopilot/recommendation-dedupe';
import { recordAutopilotDecision } from '@/lib/autopilot/log';
import {
  autopilotPolicyMetadata,
  autopilotTargetKey,
  evaluateAutopilotPolicy,
  groundAutopilotCandidate,
} from '@/lib/autopilot/policy';
import { normalizeAutopilotSettings } from '@/lib/autopilot/settings';
import {
  autopilotExecutionGloballyEnabled,
  type AutopilotCandidate,
  type AutopilotDecision,
  type AutopilotPolicyVerdict,
  type AutopilotSettings,
} from '@/lib/autopilot/types';
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
  const businessContextById = new Map<
    string,
    {
      user_id: string;
      sector: string | null;
      primary_goal: string | null;
      monthly_budget: number | null;
    }
  >();
  const businessIdsInBatch = Array.from(new Set(accounts.map((account) => account.business_id).filter(Boolean)));
  if (businessIdsInBatch.length > 0) {
    const { data: businessRows } = await supabase
      .from('businesses')
      .select('id, user_id, sector, primary_goal, monthly_budget')
      .in('id', businessIdsInBatch);
    for (const row of businessRows ?? []) {
      businessContextById.set(row.id, {
        user_id: row.user_id,
        sector: row.sector ?? null,
        primary_goal: row.primary_goal ?? null,
        monthly_budget: row.monthly_budget ?? null,
      });
    }
  }

  const ownerIds = Array.from(
    new Set(Array.from(businessContextById.values()).map((business) => business.user_id))
  );
  const userEmailById = new Map<string, string>();
  if (ownerIds.length > 0) {
    const { data: userRows, error: userLookupError } = await supabase
      .from('users')
      .select('id, email')
      .in('id', ownerIds);
    if (userLookupError) {
      console.error('Autopilot owner lookup failed; execution will fail closed', userLookupError);
    } else {
      for (const row of userRows ?? []) userEmailById.set(row.id, row.email);
    }
  }

  const accountIds = accounts.map((account) => account.id);
  const settingsByAccount = await loadAutopilotSettings(supabase, accountIds);
  const decisionHistoryState = await loadAutopilotDecisionHistory(supabase, accountIds);
  const decisionHistory = decisionHistoryState.byAccount;

  const results = {
    processed: 0,
    actions_executed: 0,
    recommendations_queued: 0,
    actions_blocked: 0,
    autopilot_observed: 0,
    autopilot_executed: 0,
    autopilot_blocked: 0,
    autopilot_failed: 0,
    autopilot_unverified: 0,
    reports_generated: 0,
    impacts_measured: 0,
    opportunities_queued: 0,
    benchmarks_refreshed: 0,
    errors: [] as string[],
  };
  // One benchmark read per distinct (sector, currency) per run, not per account.
  const benchmarkCache = new Map<string, SectorBenchmarkRow | null>();
  // Two-key launch switch: each owner must opt into conservative mode AND the
  // operator must deliberately enable the global environment flag. Missing
  // tables, malformed settings, or an unset flag all fail closed to queueing.
  const allowLiveExecution = autopilotExecutionGloballyEnabled();
  const executedThisRun = new Map<string, number>();
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

      const settings =
        settingsByAccount.get(account.id) ?? normalizeAutopilotSettings(account.id);
      const businessOwnerId = businessContext?.user_id ?? null;
      const ownerEmail = businessOwnerId ? userEmailById.get(businessOwnerId) ?? null : null;
      const accountHistory = decisionHistory.get(account.id) ?? [];
      const startOfToday = startOfSaudiDayIso();
      const executedBeforeRun = accountHistory.filter(
        (item) => item.decision === 'executed' && item.created_at >= startOfToday
      ).length;

      if (actions.length === 0) {
        await safeRecordAutopilotDecision(results, {
          supabase,
          accountId: account.id,
          jobRunId: job.id,
          mode: settings.mode,
          decision: 'no_action',
        });
      }

      // Apply the deterministic policy gate. The model only proposes actions;
      // it never decides whether a live mutation is allowed.
      const maxKeywordPauses = Math.floor(snapshot.keyword_count * 0.2);
      let keywordPauses = 0;
      for (const proposedAction of actions.slice(0, 8)) {
        let action = groundAutopilotCandidate(
          proposedAction as AutopilotCandidate,
          snapshot
        );

        if (action.type === 'pause_keyword') {
          if (keywordPauses >= maxKeywordPauses) {
            results.actions_blocked++;
            results.autopilot_blocked++;
            await safeRecordAutopilotDecision(results, {
              supabase,
              accountId: account.id,
              jobRunId: job.id,
              mode: settings.mode,
              action,
              decision: 'blocked',
              verdict: blockedVerdict(
                'mass_pause_limit',
                'أوقفنا القرار لأن حد إيقاف الكلمات في الجولة الحالية قد اكتمل.'
              ),
            });
            continue;
          }
          keywordPauses++;
        }

        const guarded = await checkGuardrails(action, account.id, supabase);
        if (!guarded) {
          results.actions_blocked++;
          results.autopilot_blocked++;
          await safeRecordAutopilotDecision(results, {
            supabase,
            accountId: account.id,
            jobRunId: job.id,
            mode: settings.mode,
            action,
            decision: 'blocked',
            verdict: blockedVerdict(
              'execution_guardrail',
              'منعت ضوابط الحساب هذا التعديل قبل الوصول إلى مرحلة التنفيذ.'
            ),
          });
          continue;
        }
        action = guarded as AutopilotCandidate;

        const targetKey = autopilotTargetKey(action);
        const cooldownCutoff = new Date(
          Date.now() - settings.cooldown_hours * 60 * 60 * 1000
        ).toISOString();
        const sameTargetExecutedWithinCooldown = accountHistory.some(
          (item) =>
            item.decision === 'executed' &&
            item.target_id === targetKey &&
            item.created_at >= cooldownCutoff
        );
        const executedToday =
          executedBeforeRun + (executedThisRun.get(account.id) ?? 0);
        const verdict = evaluateAutopilotPolicy({
          settings,
          action,
          trackingStatus: snapshot.conversion_tracking?.status ?? 'unknown',
          // Cooldown history is part of the execution proof. If the ledger is
          // unavailable we keep producing reviewable recommendations, but no
          // live mutation may pass the policy gate.
          globalExecutionEnabled: allowLiveExecution && decisionHistoryState.available,
          executedToday,
          sameTargetExecutedWithinCooldown,
        });
        const fingerprint = actionFingerprint(account.id, action);

        if (verdict.outcome === 'block') {
          results.actions_blocked++;
          results.autopilot_blocked++;
          await safeRecordAutopilotDecision(results, {
            supabase,
            accountId: account.id,
            jobRunId: job.id,
            mode: settings.mode,
            action,
            decision: 'blocked',
            verdict,
          });
          continue;
        }

        if (verdict.outcome === 'queue') {
          const queued = await queueOptimizerRecommendation({
            supabase,
            accountId: account.id,
            action,
            fingerprint,
            verdict,
            source: settings.mode === 'observe' ? 'autopilot_observe' : 'optimizer_cron',
          });
          if (queued.created) results.recommendations_queued++;
          results.autopilot_observed++;
          await safeRecordAutopilotDecision(results, {
            supabase,
            accountId: account.id,
            jobRunId: job.id,
            recommendationId: queued.id,
            mode: settings.mode,
            action,
            decision: settings.mode === 'observe' ? 'observed' : 'queued',
            verdict,
          });
          continue;
        }

        if (!businessOwnerId || !ownerEmail) {
          const ownerVerdict = blockedVerdict(
            'owner_identity_missing',
            'تعذر التحقق من صاحب الحساب؛ أوقفنا التنفيذ وحفظنا التوصية للمراجعة.'
          );
          const queued = await queueOptimizerRecommendation({
            supabase,
            accountId: account.id,
            action,
            fingerprint,
            verdict: ownerVerdict,
            source: 'autopilot_fail_closed',
          });
          if (queued.created) results.recommendations_queued++;
          results.autopilot_blocked++;
          await safeRecordAutopilotDecision(results, {
            supabase,
            accountId: account.id,
            jobRunId: job.id,
            recommendationId: queued.id,
            mode: settings.mode,
            action,
            decision: 'blocked',
            verdict: ownerVerdict,
          });
          continue;
        }

        const usage = await consumeFeatureUsage({
          supabase,
          userId: businessOwnerId,
          userEmail: ownerEmail,
          feature: 'execute_action',
          accountId: account.id,
          metadata: {
            source: 'autopilot_cron',
            policy_version: settings.config_version,
            action_type: action.type,
          },
        });
        if (!usage.ok) {
          const quotaVerdict = blockedVerdict(
            `usage_${usage.reason}`,
            'لم ننفذ التعديل لأن صلاحية الخطة أو حد الاستخدام يحتاج مراجعة.'
          );
          const queued = await queueOptimizerRecommendation({
            supabase,
            accountId: account.id,
            action,
            fingerprint,
            verdict: quotaVerdict,
            source: 'autopilot_quota_blocked',
          });
          if (queued.created) results.recommendations_queued++;
          results.autopilot_blocked++;
          await safeRecordAutopilotDecision(results, {
            supabase,
            accountId: account.id,
            jobRunId: job.id,
            recommendationId: queued.id,
            mode: settings.mode,
            action,
            decision: 'blocked',
            verdict: quotaVerdict,
          });
          continue;
        }

        const execution = await executeAutopilotAction({
          supabase,
          customer,
          accountId: account.id,
          customerId: account.customer_id,
          action,
          verdict,
          fingerprint,
          ownerUserId: businessOwnerId,
          usageEventId: usage.usageEventId,
        });

        if (execution.status === 'executed') {
          results.actions_executed++;
          results.autopilot_executed++;
          executedThisRun.set(account.id, (executedThisRun.get(account.id) ?? 0) + 1);
          accountHistory.push({
            decision: 'executed',
            target_id: targetKey,
            created_at: new Date().toISOString(),
          });
          await safeRecordAutopilotDecision(results, {
            supabase,
            accountId: account.id,
            jobRunId: job.id,
            recommendationId: execution.recommendationId,
            aiActionId: execution.aiActionId,
            mode: settings.mode,
            action,
            decision: 'executed',
            verdict,
            googleValidation: { validate_only: 'passed' },
          });
          continue;
        }

        if (execution.status === 'duplicate') {
          await safeRecordAutopilotDecision(results, {
            supabase,
            accountId: account.id,
            jobRunId: job.id,
            recommendationId: execution.recommendationId,
            mode: settings.mode,
            action,
            decision: 'queued',
            verdict: blockedVerdict(
              'duplicate_recommendation',
              'هذا القرار موجود مسبقاً ولم نكرر التنفيذ.'
            ),
          });
          continue;
        }

        if (execution.status === 'unverified') {
          results.autopilot_unverified++;
        } else {
          results.autopilot_failed++;
        }
        results.errors.push(
          `${account.customer_id}:autopilot_${execution.status}:${execution.message ?? 'unknown'}`
        );
        await safeRecordAutopilotDecision(results, {
          supabase,
          accountId: account.id,
          jobRunId: job.id,
          recommendationId: execution.recommendationId,
          aiActionId: execution.aiActionId,
          mode: settings.mode,
          action,
          decision: execution.status === 'unverified' ? 'unverified' : 'failed',
          verdict,
          reasonAr:
            execution.status === 'unverified'
              ? 'وصل الطلب إلى Google لكن تعذر تأكيد النتيجة. أوقفنا إعادة المحاولة وعلّمنا القرار للمطابقة اليدوية.'
              : 'فشل تنفيذ التعديل، ولم نحتسبه كتغيير ناجح.',
          googleValidation: {
            validate_only: execution.validateOnlyPassed === true ? 'passed' : 'failed_or_unknown',
            execution_status: execution.status,
          },
        });
      }

      if (settingsByAccount.has(account.id)) {
        const { error: lastRunError } = await supabase
          .from('autopilot_settings')
          .update({ last_run_at: new Date().toISOString() })
          .eq('account_id', account.id);
        if (lastRunError) {
          results.errors.push(`${account.customer_id}:autopilot_last_run:${lastRunError.message}`);
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
      autopilot_observed: results.autopilot_observed,
      autopilot_executed: results.autopilot_executed,
      autopilot_blocked: results.autopilot_blocked,
      autopilot_failed: results.autopilot_failed,
      autopilot_unverified: results.autopilot_unverified,
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

type AutopilotHistoryRow = {
  decision: string;
  target_id: string | null;
  created_at: string;
};

async function loadAutopilotSettings(supabase: any, accountIds: string[]) {
  const settings = new Map<string, AutopilotSettings>();
  if (accountIds.length === 0) return settings;

  const { data, error } = await supabase
    .from('autopilot_settings')
    .select(
      'account_id, mode, allowed_actions, max_daily_changes, min_confidence, cooldown_hours, require_healthy_tracking, anomaly_pause_enabled, config_version, terms_accepted_at, paused_at, pause_reason, last_run_at'
    )
    .in('account_id', accountIds);
  if (error) {
    console.error('Autopilot settings unavailable; all accounts remain off', error);
    return settings;
  }

  for (const row of data ?? []) {
    settings.set(row.account_id, normalizeAutopilotSettings(row.account_id, row));
  }
  return settings;
}

async function loadAutopilotDecisionHistory(supabase: any, accountIds: string[]) {
  const history = new Map<string, AutopilotHistoryRow[]>();
  if (accountIds.length === 0) return { byAccount: history, available: true };

  const cutoff = new Date(Date.now() - 168 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('autopilot_decisions')
    .select('account_id, decision, target_id, created_at')
    .in('account_id', accountIds)
    .eq('decision', 'executed')
    .gte('created_at', cutoff)
    .order('created_at', { ascending: false });
  if (error) {
    console.error('Autopilot history unavailable; live execution will fail closed', error);
    return { byAccount: history, available: false };
  }

  for (const row of data ?? []) {
    const rows = history.get(row.account_id) ?? [];
    rows.push({
      decision: row.decision,
      target_id: row.target_id ?? null,
      created_at: row.created_at,
    });
    history.set(row.account_id, rows);
  }
  return { byAccount: history, available: true };
}

async function safeRecordAutopilotDecision(
  results: { errors: string[] },
  input: Parameters<typeof recordAutopilotDecision>[0]
) {
  try {
    await recordAutopilotDecision(input);
  } catch (error) {
    results.errors.push(
      `${input.accountId}:autopilot_log:${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function queueOptimizerRecommendation({
  supabase,
  accountId,
  action,
  fingerprint,
  verdict,
  source,
}: {
  supabase: any;
  accountId: string;
  action: AutopilotCandidate;
  fingerprint: string;
  verdict: AutopilotPolicyVerdict;
  source: string;
}): Promise<{ id: string | null; created: boolean }> {
  const existing = await findBlockingAutopilotRecommendation(
    supabase,
    accountId,
    fingerprint
  );
  if (existing) return { id: existing.id, created: false };

  const { data, error } = await supabase
    .from('recommendations')
    .insert({
      account_id: accountId,
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
        confidence: action.confidence ?? null,
        evidence: action.evidence ?? null,
        source,
        autopilot: autopilotPolicyMetadata(verdict),
      },
      status: 'pending',
    })
    .select('id')
    .maybeSingle();
  if (error) {
    if (error.code === '23505') {
      const raced = await findBlockingAutopilotRecommendation(
        supabase,
        accountId,
        fingerprint
      );
      return { id: raced?.id ?? null, created: false };
    }
    throw error;
  }
  return { id: data?.id ?? null, created: true };
}

function blockedVerdict(code: string, reason_ar: string): AutopilotPolicyVerdict {
  return {
    outcome: 'block',
    code,
    reason_ar,
    checks: [{ code, passed: false, detail: reason_ar }],
  };
}

/** Midnight in Saudi Arabia expressed as UTC ISO for ledger comparisons. */
function startOfSaudiDayIso(now = new Date()) {
  const offsetMs = 3 * 60 * 60 * 1000;
  const shifted = new Date(now.getTime() + offsetMs);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - offsetMs).toISOString();
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
        metrics.clicks, metrics.cost_micros, metrics.conversions
      FROM search_term_view
      WHERE segments.date DURING LAST_30_DAYS
        AND metrics.clicks > 5
        AND metrics.conversions = 0
      ORDER BY metrics.cost_micros DESC
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
