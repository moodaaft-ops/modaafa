import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { createServerClient } from '@/lib/supabase/server';
import { decrypt } from '@/lib/crypto';
import { getCustomer } from '@/lib/google-ads/client';
import {
  checkGuardrails,
  executeAction,
  type OptimizerAction,
} from '@/lib/ai/optimizer-agent';
import { consumeFeatureUsage, refundFeatureUsage } from '@/lib/billing/entitlements';
import { safeLocalPath } from '@/lib/security/redirect';
import { checkRateLimit, rateLimitHeaders } from '@/lib/security/rate-limit';
import { sendOpsAlert } from '@/lib/notifications/email';

export async function POST(req: NextRequest) {
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

  if (intent === 'dismiss') {
    const { data: dismissed } = await supabase
      .from('recommendations')
      .update({ status: 'dismissed' })
      .eq('id', recommendationId)
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
      await supabase.from('ai_actions').insert({
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
        supabase,
        recommendation,
        userId: user.id,
        status: 'resource_account_mismatch',
        message: 'Action payload references a resource outside the selected Google Ads account.',
      });
      return NextResponse.redirect(new URL(`${next}?error=blocked_by_guardrails`, req.url), 303);
    }

    let preparedAction: OptimizerAction;
    let rollbackPayload: Record<string, unknown>;
    let mutationApplied = false;
    try {
      const refreshToken = decrypt(account.refresh_token_encrypted);
      const customer = getCustomer(account.customer_id, refreshToken, account.manager_id ?? undefined);
      const prepared = await prepareActionForExecution(scopedAction, customer);
      preparedAction = prepared.action;
      rollbackPayload = prepared.rollbackPayload;
    } catch (error) {
      await markExecutionFailed({
        supabase,
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
        supabase,
        recommendation,
        userId: user.id,
        status: 'blocked_by_guardrails',
        message: 'Guardrails blocked this action before Google Ads execution.',
      });
      return NextResponse.redirect(new URL(`${next}?error=blocked_by_guardrails`, req.url), 303);
    }

    const executionKey = randomUUID();
    const { data: claimed, error: claimError } = await supabase
      .from('recommendations')
      .update({
        status: 'executing',
        execution_key: executionKey,
        execution_started_at: new Date().toISOString(),
        applied_by: user.id,
      })
      .eq('id', recommendation.id)
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
      await releaseExecutionClaim(supabase, recommendation.id, executionKey);
      return NextResponse.redirect(new URL(`${next}?error=${usage.reason}`, req.url), 303);
    }

    try {
      const refreshToken = decrypt(account.refresh_token_encrypted);
      const customer = getCustomer(account.customer_id, refreshToken, account.manager_id ?? undefined);
      await executeAction(safe, customer, { validateOnly: true });
      const result = await executeAction(safe, customer);
      mutationApplied = true;
      const appliedAt = new Date().toISOString();
      const appliedResult = {
        status: 'applied',
        validate_only: 'passed',
        google_ads_result: result,
      };

      const { data: actionLog, error: actionLogError } = await supabase.from('ai_actions').insert({
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
        },
        rollback_payload: finalizeRollbackPayload(rollbackPayload, result),
        result: appliedResult,
        expected_impact: recommendation.expected_impact,
      }).select('id').maybeSingle();
      if (actionLogError || !actionLog) {
        throw new Error(`Unable to persist executed Google Ads action: ${actionLogError?.message ?? 'no row returned'}`);
      }

      const { data: appliedRecommendation, error: appliedError } = await supabase
        .from('recommendations')
        .update({
          status: 'applied',
          applied_at: appliedAt,
          applied_by: user.id,
          applied_result: appliedResult,
        })
        .eq('id', recommendation.id)
        .eq('execution_key', executionKey)
        .eq('status', 'executing')
        .select('id')
        .maybeSingle();
      if (appliedError || !appliedRecommendation) {
        throw new Error(`Unable to mark executed recommendation as applied: ${appliedError?.message ?? 'no row returned'}`);
      }

      return NextResponse.redirect(new URL(`${next}?executed=1`, req.url), 303);
    } catch (error) {
      if (mutationApplied) {
        console.error('Google Ads mutation succeeded but execution recording failed', {
          recommendationId: recommendation.id,
          accountId: account.id,
          executionKey,
          error: operationalError(error),
        });
        await safeExecutionAlert({
          subject: 'تعديل Google Ads يحتاج مطابقة يدوية',
          message: 'نجح إرسال التعديل إلى Google Ads لكن تعذر تأكيد حفظ سجل التنفيذ. تُركت التوصية مقفلة لمنع تكرار التعديل.',
          details: {
            recommendation_id: recommendation.id,
            account_id: account.id,
            execution_key: executionKey,
            action_type: safe.type,
            error: operationalError(error),
          },
        });
        return NextResponse.redirect(new URL(`${next}?error=execution_recording_failed`, req.url), 303);
      }

      await refundFeatureUsage({ supabase, userId: user.id, usageEventId: usage.usageEventId });
      await markExecutionFailed({
        supabase,
        recommendation,
        userId: user.id,
        status: 'execution_failed',
        message: error instanceof Error ? error.message : String(error),
        executionKey,
      });
      return NextResponse.redirect(new URL(`${next}?error=execution_failed`, req.url), 303);
    }
  }

  const { data: approved } = await supabase
    .from('recommendations')
    .update({ status: 'approved', applied_by: user.id })
    .eq('id', recommendationId)
    .in('status', ['pending', 'failed'])
    .select('id')
    .maybeSingle();

  if (!approved) {
    return NextResponse.redirect(new URL(`${next}?error=recommendation_locked`, req.url), 303);
  }

  await supabase.from('ai_actions').insert({
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

function buildExecutableAction(
  payload: any,
  recommendation: any,
  accountCustomerId?: string | null
): OptimizerAction | null {
  const operation = String(payload?.operation ?? '');
  const allowed = ['pause_keyword', 'add_negative_keyword', 'adjust_budget', 'adjust_bid', 'pause_ad'];
  if (!allowed.includes(operation)) return null;

  const params = payload?.params ?? {};
  const targetId = String(payload?.target_id ?? '');
  const base = {
    type: operation as OptimizerAction['type'],
    target_id: targetId,
    params,
    reason_ar: recommendation.description ?? recommendation.title,
    reason_en: recommendation.title,
    expected_impact: {
      metric: String(recommendation.expected_impact?.metric ?? 'performance'),
      delta_pct: Number(recommendation.expected_impact?.delta_pct ?? 0),
      delta_sar_per_month: Number(recommendation.expected_impact?.delta_sar_per_month ?? 0),
    },
  } satisfies OptimizerAction;

  if (operation === 'pause_keyword' || operation === 'pause_ad') {
    const resourceType = operation === 'pause_keyword' ? 'adGroupCriteria' : 'adGroupAds';
    return validGoogleAdsResource(targetId, resourceType, accountCustomerId) ? base : null;
  }

  if (operation === 'add_negative_keyword') {
    const campaignResource = String(params.campaign_resource ?? '');
    const keywordText = String(params.keyword_text ?? '').trim();
    const matchType = String(params.match_type ?? '').trim();
    if (
      !validGoogleAdsResource(campaignResource, 'campaigns', accountCustomerId) ||
      !keywordText ||
      !['EXACT', 'PHRASE', 'BROAD'].includes(matchType)
    ) {
      return null;
    }
    return base;
  }

  if (operation === 'adjust_budget') {
    const budgetResource = String(params.budget_resource ?? '');
    const newAmountMicros = Number(params.new_amount_micros ?? 0);
    if (
      !validGoogleAdsResource(budgetResource, 'campaignBudgets', accountCustomerId) ||
      !Number.isFinite(newAmountMicros) ||
      newAmountMicros <= 0
    ) {
      return null;
    }
    return base;
  }

  if (operation === 'adjust_bid') {
    const adGroupResource = String(params.ad_group_resource ?? '');
    const hasBidTarget = params.target_cpa_micros !== undefined || params.target_roas !== undefined;
    if (!validGoogleAdsResource(adGroupResource, 'adGroups', accountCustomerId) || !hasBidTarget) return null;
    return base;
  }

  return null;
}

async function markExecutionFailed({
  supabase,
  recommendation,
  userId,
  status,
  message,
  executionKey,
}: {
  supabase: any;
  recommendation: any;
  userId: string;
  status: string;
  message: string;
  executionKey?: string;
}) {
  let updateQuery = supabase
    .from('recommendations')
    .update({
      status: 'failed',
      applied_by: userId,
      applied_result: { status, message },
    })
    .eq('id', recommendation.id);
  if (executionKey) {
    updateQuery = updateQuery.eq('execution_key', executionKey).eq('status', 'executing');
  }
  await updateQuery;

  await supabase.from('ai_actions').insert({
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

async function releaseExecutionClaim(supabase: any, recommendationId: string, executionKey: string) {
  await supabase
    .from('recommendations')
    .update({ status: 'approved', execution_key: null, execution_started_at: null })
    .eq('id', recommendationId)
    .eq('execution_key', executionKey)
    .eq('status', 'executing');
}

/**
 * Resource names must belong to the SELECTED account, not just any account.
 * The customer id was previously left as a wildcard, so an action payload
 * could name a resource under a different `customers/<id>/…`; only Google's
 * own scoping stopped the write.
 */
function validGoogleAdsResource(value: string, resourceType: string, accountCustomerId?: string | null) {
  const customerPattern = accountCustomerId ? accountCustomerId.replace(/\D/g, '') : '\\d+';
  if (accountCustomerId && !customerPattern) return false;
  return new RegExp(`^customers/${customerPattern}/${resourceType}/[^/]+$`).test(value);
}

async function prepareActionForExecution(action: OptimizerAction, customer: any) {
  const params = { ...action.params };
  let rollbackPayload: Record<string, unknown> = { reversible: true };

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
    params.current_amount_micros = currentAmountMicros;
    params.delta_pct = ((Number(params.new_amount_micros) - currentAmountMicros) / currentAmountMicros) * 100;
    rollbackPayload = {
      reversible: true,
      action_type: 'adjust_budget',
      budget_resource: resourceName,
      amount_micros: currentAmountMicros,
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
  } else if (action.type === 'add_negative_keyword') {
    rollbackPayload = {
      reversible: true,
      action_type: 'remove_created_negative_keyword',
      resource_name_from_result: true,
    };
  }

  return { action: { ...action, params }, rollbackPayload };
}

function escapeGaql(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function finalizeRollbackPayload(payload: Record<string, unknown>, result: any) {
  if (payload.action_type !== 'remove_created_negative_keyword') return payload;
  const resourceName =
    result?.results?.[0]?.resourceName ??
    result?.results?.[0]?.resource_name ??
    result?.resourceName ??
    result?.resource_name ??
    null;
  return { ...payload, resource_name: resourceName };
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
