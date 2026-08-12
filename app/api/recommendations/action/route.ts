import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { createAdminClient, createServerClient } from '@/lib/supabase/server';
import { decrypt } from '@/lib/crypto';
import { getCustomer } from '@/lib/google-ads/client';
import {
  checkGuardrails,
  executeAction,
  type OptimizerAction,
} from '@/lib/ai/optimizer-agent';
import { buildExecutableAction } from '@/lib/ai/executable-action';
import {
  consumeFeatureUsage,
  getSubscriptionAccess,
  refundFeatureUsage,
} from '@/lib/billing/entitlements';
import { safeLocalPath } from '@/lib/security/redirect';
import { checkRateLimit, rateLimitHeaders } from '@/lib/security/rate-limit';
import { sendOpsAlert } from '@/lib/notifications/email';
import { isSameOriginRequest } from '@/lib/security/origin';

export async function POST(req: NextRequest) {

  // Defence in depth against cross-site POSTs; see lib/security/origin.ts.
  if (!isSameOriginRequest(req)) {
    return NextResponse.redirect(new URL('/optimizer?error=invalid_origin', req.url), 303);
  }
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return NextResponse.redirect(new URL('/login', req.url), 303);

  try {
    const rateLimit = await checkRateLimit({ req, scope: 'recommendation_action', limit: 20, windowSeconds: 60, identifier: user.id });
    if (!rateLimit.allowed) {
      return NextResponse.json({ error: 'too_many_requests' }, { status: 429, headers: rateLimitHeaders(rateLimit) });
    }
  } catch {
    return NextResponse.json({ error: 'security_service_unavailable' }, { status: 503 });
  }

  const form = await req.formData();
  const recommendationId = String(form.get('recommendation_id') ?? '');
  const intent = String(form.get('intent') ?? '');
  const next = safeLocalPath(String(form.get('next') ?? '/optimizer'), '/optimizer');

  if (!recommendationId || !['approve', 'dismiss', 'execute'].includes(intent)) {
    return NextResponse.redirect(new URL(`${next}?error=invalid_recommendation_action`, req.url), 303);
  }

  const { data: recommendation, error: recError } = await supabase
    .from('recommendations')
    .select('id, account_id, title, description, expected_impact, action_payload, status')
    .eq('id', recommendationId)
    .single();

  if (recError || !recommendation) {
    return NextResponse.redirect(new URL(`${next}?error=recommendation_not_found`, req.url), 303);
  }

  // Executable recommendation state and ai_actions are not client-writable.
  // Ownership is established by the RLS read above; every mutation below then
  // uses the service role and remains scoped to that verified row/account.
  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return NextResponse.redirect(new URL(`${next}?error=service_unavailable`, req.url), 303);
  }

  if (intent === 'dismiss') {
    const { data: dismissed } = await admin
      .from('recommendations')
      .update({ status: 'dismissed' })
      .eq('id', recommendationId)
      .eq('account_id', recommendation.account_id)
      .in('status', ['pending', 'approved', 'failed'])
      .select('id')
      .maybeSingle();
    if (!dismissed) {
      return NextResponse.redirect(new URL(`${next}?error=recommendation_locked`, req.url), 303);
    }
    return NextResponse.redirect(new URL(`${next}?updated=1`, req.url), 303);
  }

  if (intent === 'execute') {
    if (recommendation.status !== 'approved') {
      return NextResponse.redirect(new URL(`${next}?error=approve_before_execution`, req.url), 303);
    }

    const action = buildExecutableAction(recommendation.action_payload, recommendation);
    if (!action) {
      await admin.from('ai_actions').insert({
        account_id: recommendation.account_id,
        action_type: 'execution_blocked',
        description_ar: `تحتاج مراجعة يدوية: ${recommendation.title}`,
        description_en: `Manual review required: ${recommendation.title}`,
        reason: recommendation.description,
        payload: {
          recommendation_id: recommendation.id,
          action_payload: recommendation.action_payload,
        },
        expected_impact: recommendation.expected_impact,
        result: {
          status: 'manual_review_required',
          note: 'Recommendation payload is descriptive and cannot be safely executed automatically.',
        },
      });

      return NextResponse.redirect(new URL(`${next}?error=manual_review_required`, req.url), 303);
    }

    const { data: account, error: accountError } = await supabase
      .from('google_ads_accounts')
      .select('id, customer_id, manager_id, currency_code, refresh_token_encrypted')
      .eq('id', recommendation.account_id)
      .eq('status', 'active')
      .maybeSingle();

    if (accountError || !account) {
      return NextResponse.redirect(new URL(`${next}?error=account_not_found`, req.url), 303);
    }

    // Cheap entitlement gate BEFORE the Google Ads preflight. The quota
    // reservation further down is still authoritative; this check exists so a
    // lapsed subscriber repeatedly clicking تنفيذ does not spend live Google
    // Ads reads and guardrail aggregation against the shared developer token
    // just to be told no afterwards.
    const subscriptionAccess = await getSubscriptionAccess(supabase, user.id);
    if (!subscriptionAccess.active) {
      return NextResponse.redirect(new URL(`${next}?error=subscription_required`, req.url), 303);
    }

    // Re-validate the resource names against THIS account's customer id now
    // that it is known. The first pass accepts any `customers/<id>/…`, so
    // without this a payload could name a resource in a different account.
    const scopedAction = buildExecutableAction(
      recommendation.action_payload,
      recommendation,
      account.customer_id
    );
    if (!scopedAction) {
      await markExecutionFailed({
        admin,
        recommendation,
        userId: user.id,
        status: 'resource_account_mismatch',
        message: 'Action payload references a resource outside the selected Google Ads account.',
      });
      return NextResponse.redirect(new URL(`${next}?error=blocked_by_guardrails`, req.url), 303);
    }

    let preparedAction: OptimizerAction;
    let rollbackPayload: Record<string, unknown>;
    let measurement: MeasurementDescriptor | null;
    let mutationApplied = false;
    let liveMutationOutcomeUnknown = false;
    try {
      const refreshToken = decrypt(account.refresh_token_encrypted);
      const customer = getCustomer(account.customer_id, refreshToken, account.manager_id ?? undefined);
      const prepared = await prepareActionForExecution(scopedAction, customer);
      preparedAction = prepared.action;
      rollbackPayload = prepared.rollbackPayload;
      measurement = prepared.measurement;
    } catch (error) {
      await markExecutionFailed({
        admin,
        recommendation,
        userId: user.id,
        status: 'preflight_failed',
        message: error instanceof Error ? error.message : String(error),
      });
      return NextResponse.redirect(new URL(`${next}?error=execution_failed`, req.url), 303);
    }

    const safe = await checkGuardrails(preparedAction, account.id, supabase);
    if (!safe) {
      await markExecutionFailed({
        admin,
        recommendation,
        userId: user.id,
        status: 'blocked_by_guardrails',
        message: 'Guardrails blocked this action before Google Ads execution.',
      });
      return NextResponse.redirect(new URL(`${next}?error=blocked_by_guardrails`, req.url), 303);
    }

    const executionKey = randomUUID();
    const { data: claimed, error: claimError } = await admin
      .from('recommendations')
      .update({
        status: 'executing',
        execution_key: executionKey,
        execution_started_at: new Date().toISOString(),
        applied_by: user.id,
      })
      .eq('id', recommendation.id)
      .eq('account_id', recommendation.account_id)
      .eq('status', 'approved')
      .select('id')
      .maybeSingle();

    if (claimError || !claimed) {
      return NextResponse.redirect(new URL(`${next}?error=already_executing`, req.url), 303);
    }

    const usage = await consumeFeatureUsage({
      supabase,
      userId: user.id,
      feature: 'execute_action',
      accountId: account.id,
      metadata: { recommendation_id: recommendation.id, customer_id: account.customer_id },
    });
    if (!usage.ok) {
      await releaseExecutionClaim(admin, recommendation, executionKey);
      return NextResponse.redirect(new URL(`${next}?error=${usage.reason}`, req.url), 303);
    }

    try {
      const refreshToken = decrypt(account.refresh_token_encrypted);
      const customer = getCustomer(account.customer_id, refreshToken, account.manager_id ?? undefined);
      await executeAction(safe, customer, { validateOnly: true });
      let result: unknown;
      try {
        result = await executeAction(safe, customer);
      } catch (mutateError) {
        // A client-side timeout on the LIVE mutate is ambiguous: Google may
        // have committed the change after our 20s deadline. Marking it
        // `failed` (re-executable) risked a duplicate apply of a
        // non-idempotent create. Flag it so the catch below keeps the row
        // locked and asks for manual verification instead.
        const errorName = (mutateError as { name?: string })?.name;
        if (errorName === 'TimeoutError' || errorName === 'AbortError') {
          liveMutationOutcomeUnknown = true;
        }
        throw mutateError;
      }
      mutationApplied = true;
      const appliedAt = new Date().toISOString();
      const appliedResult = {
        status: 'applied',
        validate_only: 'passed',
        google_ads_result: result,
      };

      const { data: actionLog, error: actionLogError } = await admin.from('ai_actions').insert({
        account_id: recommendation.account_id,
        recommendation_id: recommendation.id,
        execution_key: executionKey,
        action_type: safe.type,
        description_ar: recommendation.description ?? recommendation.title,
        description_en: `Executed recommendation: ${recommendation.title}`,
        reason: safe.reason_en,
        payload: {
          recommendation_id: recommendation.id,
          action: safe,
          measurement: finalizeMeasurement(measurement, result),
        },
        rollback_payload: finalizeRollbackPayload(rollbackPayload, result),
        result: appliedResult,
        expected_impact: recommendation.expected_impact,
      }).select('id').maybeSingle();
      if (actionLogError || !actionLog) {
        throw new Error(`Unable to persist executed Google Ads action: ${actionLogError?.message ?? 'no row returned'}`);
      }

      const { data: appliedRecommendation, error: appliedError } = await admin
        .from('recommendations')
        .update({
          status: 'applied',
          applied_at: appliedAt,
          applied_by: user.id,
          applied_result: appliedResult,
        })
        .eq('id', recommendation.id)
        .eq('account_id', recommendation.account_id)
        .eq('execution_key', executionKey)
        .eq('status', 'executing')
        .select('id')
        .maybeSingle();
      if (appliedError || !appliedRecommendation) {
        throw new Error(`Unable to mark executed recommendation as applied: ${appliedError?.message ?? 'no row returned'}`);
      }

      return NextResponse.redirect(new URL(`${next}?executed=1`, req.url), 303);
    } catch (error) {
      if (mutationApplied || liveMutationOutcomeUnknown) {
        console.error(
          mutationApplied
            ? 'Google Ads mutation succeeded but execution recording failed'
            : 'Google Ads mutation timed out with an unknown outcome',
          {
            recommendationId: recommendation.id,
            accountId: account.id,
            executionKey,
            error: operationalError(error),
          }
        );
        await safeExecutionAlert({
          subject: mutationApplied
            ? 'تعديل Google Ads يحتاج مطابقة يدوية'
            : 'نتيجة تعديل Google Ads غير مؤكدة',
          message: mutationApplied
            ? 'نجح إرسال التعديل إلى Google Ads لكن تعذر تأكيد حفظ سجل التنفيذ. تُركت التوصية مقفلة لمنع تكرار التعديل.'
            : 'انتهت مهلة نداء التعديل بعد إرساله إلى Google Ads وقد يكون طُبق فعلاً. تُركت التوصية مقفلة — راجع سجل التغييرات في Google Ads قبل أي إعادة تنفيذ.',
          details: {
            recommendation_id: recommendation.id,
            account_id: account.id,
            execution_key: executionKey,
            action_type: safe.type,
            outcome: mutationApplied ? 'applied_recording_failed' : 'unknown_after_timeout',
            error: operationalError(error),
          },
        });
        return NextResponse.redirect(
          new URL(
            `${next}?error=${mutationApplied ? 'execution_recording_failed' : 'execution_unverified'}`,
            req.url
          ),
          303
        );
      }

      await refundFeatureUsage({ userId: user.id, usageEventId: usage.usageEventId });
      await markExecutionFailed({
        admin,
        recommendation,
        userId: user.id,
        status: 'execution_failed',
        message: error instanceof Error ? error.message : String(error),
        executionKey,
      });
      return NextResponse.redirect(new URL(`${next}?error=execution_failed`, req.url), 303);
    }
  }

  const { data: approved } = await admin
    .from('recommendations')
    .update({ status: 'approved', applied_by: user.id })
    .eq('id', recommendationId)
    .eq('account_id', recommendation.account_id)
    .in('status', ['pending', 'failed'])
    .select('id')
    .maybeSingle();

  if (!approved) {
    return NextResponse.redirect(new URL(`${next}?error=recommendation_locked`, req.url), 303);
  }

  await admin.from('ai_actions').insert({
    account_id: recommendation.account_id,
    recommendation_id: recommendation.id,
    action_type: 'approval_queued',
    description_ar: `تم اعتماد التوصية: ${recommendation.title}`,
    description_en: `Recommendation approved: ${recommendation.title}`,
    reason: recommendation.description,
    payload: {
      recommendation_id: recommendation.id,
      action_payload: recommendation.action_payload,
      requires_final_execution: true,
    },
    expected_impact: recommendation.expected_impact,
    result: {
      status: 'queued_for_execution',
      note: 'No live Google Ads mutation was executed by this approval action.',
    },
  });

  return NextResponse.redirect(new URL(`${next}?approved=1`, req.url), 303);
}

async function markExecutionFailed({
  admin,
  recommendation,
  userId,
  status,
  message,
  executionKey,
}: {
  admin: any;
  recommendation: any;
  userId: string;
  status: string;
  message: string;
  executionKey?: string;
}) {
  let updateQuery = admin
    .from('recommendations')
    .update({
      status: 'failed',
      applied_by: userId,
      applied_result: { status, message },
    })
    .eq('id', recommendation.id)
    .eq('account_id', recommendation.account_id);
  if (executionKey) {
    updateQuery = updateQuery.eq('execution_key', executionKey).eq('status', 'executing');
  } else {
    // Fail CLOSED: the pre-claim failure paths (preflight, guardrails,
    // resource mismatch) may only demote a row that is still `approved`.
    // Without this guard, request B's transient preflight failure flipped a
    // row that request A had just claimed (`executing`) — or even finished
    // (`applied`) — back to `failed`, which the approve path accepts, re-arming
    // a second live execution of an already-applied mutation.
    updateQuery = updateQuery.eq('status', 'approved');
  }
  await updateQuery;

  await admin.from('ai_actions').insert({
    account_id: recommendation.account_id,
    recommendation_id: recommendation.id,
    execution_key: executionKey ?? null,
    action_type: status,
    description_ar: `تعذر تنفيذ التوصية: ${recommendation.title}`,
    description_en: `Recommendation execution failed: ${recommendation.title}`,
    reason: message,
    payload: {
      recommendation_id: recommendation.id,
      action_payload: recommendation.action_payload,
    },
    expected_impact: recommendation.expected_impact,
    result: { status, message },
  });
}

async function releaseExecutionClaim(
  admin: any,
  recommendation: { id: string; account_id: string },
  executionKey: string
) {
  await admin
    .from('recommendations')
    .update({ status: 'approved', execution_key: null, execution_started_at: null })
    .eq('id', recommendation.id)
    .eq('account_id', recommendation.account_id)
    .eq('execution_key', executionKey)
    .eq('status', 'executing');
}

/**
 * Where and how to measure this action's real-world effect ~7 days after
 * execution. `before` is a 7-day snapshot captured NOW so the nightly
 * measurement pass can compute an honest before/after delta and write it into
 * ai_actions.observed_impact — the learning loop that lets the product say
 * "هذا القرار وفّر X فعلياً" instead of only predicting.
 */
type MeasurementDescriptor = {
  level: 'budget_campaigns' | 'ad_group' | 'criterion' | 'ad' | 'created_criterion';
  resource: string | null;
  window_days: number;
  before: { cost: number; clicks: number; conversions: number; conversion_value: number } | null;
  captured_at: string;
};

async function readSevenDayMetrics(
  customer: any,
  fromClause: string,
  whereField: string,
  resourceName: string
) {
  try {
    const rows = await customer.query(`
      SELECT metrics.cost_micros, metrics.clicks, metrics.conversions, metrics.conversions_value
      FROM ${fromClause}
      WHERE ${whereField} = '${escapeGaql(resourceName)}'
        AND segments.date DURING LAST_7_DAYS
    `);
    return sumMetricRows(rows);
  } catch {
    // Metrics are an enhancement, never a blocker for execution.
    return null;
  }
}

function sumMetricRows(rows: any[]) {
  const totals = { cost: 0, clicks: 0, conversions: 0, conversion_value: 0 };
  for (const row of rows ?? []) {
    const metrics = row?.metrics ?? {};
    totals.cost += Number(metrics.costMicros ?? metrics.cost_micros ?? 0) / 1_000_000;
    totals.clicks += Number(metrics.clicks ?? 0);
    totals.conversions += Number(metrics.conversions ?? 0);
    totals.conversion_value += Number(metrics.conversionsValue ?? metrics.conversions_value ?? 0);
  }
  totals.cost = Number(totals.cost.toFixed(2));
  totals.conversions = Number(totals.conversions.toFixed(3));
  totals.conversion_value = Number(totals.conversion_value.toFixed(2));
  return totals;
}

async function prepareActionForExecution(action: OptimizerAction, customer: any) {
  const params = { ...action.params };
  let rollbackPayload: Record<string, unknown> = { reversible: true };
  const capturedAt = new Date().toISOString();
  let measurement: MeasurementDescriptor | null = null;

  if (action.type === 'adjust_budget') {
    const resourceName = String(params.budget_resource);
    const rows = await customer.query(`
      SELECT campaign_budget.resource_name, campaign_budget.amount_micros
      FROM campaign_budget
      WHERE campaign_budget.resource_name = '${escapeGaql(resourceName)}'
      LIMIT 1
    `);
    const budget = rows[0]?.campaignBudget ?? rows[0]?.campaign_budget;
    const currentAmountMicros = Number(budget?.amountMicros ?? budget?.amount_micros ?? 0);
    if (!currentAmountMicros) throw new Error('Unable to read current campaign budget before execution');
    // A delta-only payload (what the optimizer prompt produced historically)
    // becomes executable HERE, against the live budget — not against whatever
    // the budget was on the night the recommendation was queued.
    if (!(Number(params.new_amount_micros) > 0)) {
      const deltaPct = Number(params.delta_pct);
      if (!Number.isFinite(deltaPct) || deltaPct === 0) {
        throw new Error('Budget action carries neither an absolute amount nor a delta');
      }
      params.new_amount_micros = Math.round(currentAmountMicros * (1 + deltaPct / 100));
    }
    params.current_amount_micros = currentAmountMicros;
    params.delta_pct = ((Number(params.new_amount_micros) - currentAmountMicros) / currentAmountMicros) * 100;
    rollbackPayload = {
      reversible: true,
      action_type: 'adjust_budget',
      budget_resource: resourceName,
      amount_micros: currentAmountMicros,
    };
    measurement = {
      level: 'budget_campaigns',
      resource: resourceName,
      window_days: 7,
      before: await readSevenDayMetrics(customer, 'campaign', 'campaign.campaign_budget', resourceName),
      captured_at: capturedAt,
    };
  } else if (action.type === 'pause_keyword') {
    const rows = await customer.query(`
      SELECT ad_group_criterion.resource_name, ad_group_criterion.status
      FROM keyword_view
      WHERE ad_group_criterion.resource_name = '${escapeGaql(action.target_id)}'
      LIMIT 1
    `);
    const criterion = rows[0]?.adGroupCriterion ?? rows[0]?.ad_group_criterion;
    const previousStatus = criterion?.status;
    if (!previousStatus) throw new Error('Unable to read keyword status before execution');
    rollbackPayload = { reversible: true, action_type: 'pause_keyword', resource_name: action.target_id, status: previousStatus };
    measurement = {
      level: 'criterion',
      resource: action.target_id,
      window_days: 7,
      before: await readSevenDayMetrics(customer, 'keyword_view', 'ad_group_criterion.resource_name', action.target_id),
      captured_at: capturedAt,
    };
  } else if (action.type === 'pause_ad') {
    const rows = await customer.query(`
      SELECT ad_group_ad.resource_name, ad_group_ad.status
      FROM ad_group_ad
      WHERE ad_group_ad.resource_name = '${escapeGaql(action.target_id)}'
      LIMIT 1
    `);
    const ad = rows[0]?.adGroupAd ?? rows[0]?.ad_group_ad;
    const previousStatus = ad?.status;
    if (!previousStatus) throw new Error('Unable to read ad status before execution');
    rollbackPayload = { reversible: true, action_type: 'pause_ad', resource_name: action.target_id, status: previousStatus };
    measurement = {
      level: 'ad',
      resource: action.target_id,
      window_days: 7,
      before: await readSevenDayMetrics(customer, 'ad_group_ad', 'ad_group_ad.resource_name', action.target_id),
      captured_at: capturedAt,
    };
  } else if (action.type === 'adjust_bid') {
    const resourceName = String(params.ad_group_resource);
    const rows = await customer.query(`
      SELECT ad_group.resource_name, ad_group.target_cpa_micros, ad_group.target_roas
      FROM ad_group
      WHERE ad_group.resource_name = '${escapeGaql(resourceName)}'
      LIMIT 1
    `);
    const adGroup = rows[0]?.adGroup ?? rows[0]?.ad_group;
    if (!adGroup) throw new Error('Unable to read ad group bid targets before execution');
    const currentTargetCpa = adGroup.targetCpaMicros ?? adGroup.target_cpa_micros ?? null;
    const currentTargetRoas = adGroup.targetRoas ?? adGroup.target_roas ?? null;
    // Hand the current values to checkGuardrails. They were already being read
    // here and then discarded into the rollback payload, so the ±20% bid bound
    // promised by the system prompt had nothing to compare against and was
    // never enforced.
    if (currentTargetCpa !== null) params.current_target_cpa_micros = Number(currentTargetCpa);
    if (currentTargetRoas !== null) params.current_target_roas = Number(currentTargetRoas);
    rollbackPayload = {
      reversible: true,
      action_type: 'adjust_bid',
      ad_group_resource: resourceName,
      target_cpa_micros: currentTargetCpa,
      target_roas: currentTargetRoas,
    };
    measurement = {
      level: 'ad_group',
      resource: resourceName,
      window_days: 7,
      before: await readSevenDayMetrics(customer, 'ad_group', 'ad_group.resource_name', resourceName),
      captured_at: capturedAt,
    };
  } else if (action.type === 'add_negative_keyword') {
    rollbackPayload = {
      reversible: true,
      action_type: 'remove_created_negative_keyword',
      resource_name_from_result: true,
    };
  } else if (action.type === 'add_keyword') {
    // A veteran never adds a keyword that already exists: it fragments stats
    // and can double-serve. Refuse when the same text+match is live anywhere
    // in the account.
    const keywordText = String(params.keyword_text ?? '').trim();
    const matchType = String(params.match_type ?? '').trim();
    const existing = await customer.query(`
      SELECT ad_group_criterion.resource_name
      FROM keyword_view
      WHERE ad_group_criterion.keyword.text = '${escapeGaql(keywordText)}'
        AND ad_group_criterion.keyword.match_type = '${escapeGaql(matchType)}'
        AND ad_group_criterion.status != 'REMOVED'
      LIMIT 1
    `);
    if (existing.length > 0) {
      throw new Error('Keyword already exists in this account; promotion skipped to avoid duplicate serving.');
    }
    rollbackPayload = {
      reversible: true,
      action_type: 'remove_created_keyword',
      resource_name_from_result: true,
    };
    measurement = {
      level: 'created_criterion',
      resource: null, // patched from the mutate result after execution
      window_days: 7,
      before: { cost: 0, clicks: 0, conversions: 0, conversion_value: 0 },
      captured_at: capturedAt,
    };
  }

  return { action: { ...action, params }, rollbackPayload, measurement };
}

function escapeGaql(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function firstResultResourceName(result: any): string | null {
  return (
    result?.results?.[0]?.resourceName ??
    result?.results?.[0]?.resource_name ??
    result?.resourceName ??
    result?.resource_name ??
    null
  );
}

function finalizeRollbackPayload(payload: Record<string, unknown>, result: any) {
  if (
    payload.action_type !== 'remove_created_negative_keyword' &&
    payload.action_type !== 'remove_created_keyword'
  ) {
    return payload;
  }
  return { ...payload, resource_name: firstResultResourceName(result) };
}

function finalizeMeasurement(measurement: MeasurementDescriptor | null, result: any) {
  if (!measurement) return null;
  if (measurement.level === 'created_criterion' && !measurement.resource) {
    return { ...measurement, resource: firstResultResourceName(result) };
  }
  return measurement;
}

async function safeExecutionAlert(payload: Parameters<typeof sendOpsAlert>[0]) {
  try {
    await sendOpsAlert(payload);
  } catch (error) {
    console.error('Failed to send recommendation execution alert', operationalError(error));
  }
}

function operationalError(error: unknown) {
  return error instanceof Error
    ? { name: error.name, message: error.message.slice(0, 1000) }
    : { message: String(error).slice(0, 1000) };
}
