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
  isAmbiguousGoogleAdsMutationError,
  prepareActionForExecution,
  type MeasurementDescriptor,
} from '@/lib/ai/execution-preflight';
import { isExtendedActionsEnabled } from '@/lib/ai/extended-actions/flag';
import { isExtendedOperation } from '@/lib/ai/extended-actions/types';
import { readbackExtendedAction } from '@/lib/ai/extended-actions/readback';
import { finalizeMeasurement, finalizeRollbackPayload } from '@/lib/ai/execution-result';
import {
  consumeFeatureUsage,
  getSubscriptionAccess,
  refundFeatureUsage,
} from '@/lib/billing/entitlements';
import { hasProductAccess } from '@/lib/billing/access-gate';
import { safeLocalPath } from '@/lib/security/redirect';
import { checkRateLimit, rateLimitHeaders } from '@/lib/security/rate-limit';
import { sendOpsAlert } from '@/lib/notifications/email';
import { isSameOriginRequest } from '@/lib/security/origin';
import { isExpiredOptimizerMoneyMove, isOptimizerRecommendation } from '@/lib/recommendations/staleness';

const defaultDependencies = {
  createServerClient,
  createAdminClient,
  checkRateLimit,
  decrypt,
  getCustomer,
  getSubscriptionAccess,
  consumeFeatureUsage,
  refundFeatureUsage,
  prepareActionForExecution,
  checkGuardrails,
  executeAction,
  sendOpsAlert,
  randomUUID,
};

export type RecommendationActionDependencies = typeof defaultDependencies;

export const RECOMMENDATION_INTENTS = ['approve', 'dismiss', 'execute', 'approve_execute'] as const;

/**
 * Form POST handler behind app/api/recommendations/action/route.ts.
 *
 * Intents:
 *  - approve:          pending|failed -> approved (+ approval_queued log row)
 *  - execute:          approved -> executing -> applied, with every live check
 *  - approve_execute:  approve, then the SAME execute path, in one submit
 *  - dismiss:          pending|approved|failed -> dismissed
 *
 * The route passes no overrides. Tests replace the Supabase, Google Ads and
 * billing boundaries so they exercise the real control flow (ordering of the
 * approval, entitlement, preflight, guardrail, claim, quota and mutate steps)
 * without contacting any external service.
 */
export function createRecommendationActionHandler(
  overrides: Partial<RecommendationActionDependencies> = {}
) {
  const deps: RecommendationActionDependencies = { ...defaultDependencies, ...overrides };

  return async function handleRecommendationAction(req: NextRequest) {
    // Defence in depth against cross-site POSTs; see lib/security/origin.ts.
    if (!isSameOriginRequest(req)) {
      return NextResponse.redirect(new URL('/optimizer?error=invalid_origin', req.url), 303);
    }
    const supabase = await deps.createServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) return NextResponse.redirect(new URL('/login', req.url), 303);

    try {
      const rateLimit = await deps.checkRateLimit({ req, scope: 'recommendation_action', limit: 20, windowSeconds: 60, identifier: user.id });
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

    if (!recommendationId || !(RECOMMENDATION_INTENTS as readonly string[]).includes(intent)) {
      return NextResponse.redirect(new URL(`${next}?error=invalid_recommendation_action`, req.url), 303);
    }

    // Approving and applying a change belongs to an account with access: an
    // active subscription, a live trial or an operator free plan. This runs
    // before the row is read and before anything is written, for approve,
    // approve_execute and execute alike, so a visitor without access can no
    // longer leave an `approved` row behind. «مو الحين» (dismiss) stays open: it
    // changes nothing on the account.
    if (intent !== 'dismiss') {
      const subscriptionAccess = await deps.getSubscriptionAccess(supabase, user.id, user.email);
      if (!hasProductAccess(subscriptionAccess)) {
        return NextResponse.redirect(new URL(`${next}?error=subscription_required`, req.url), 303);
      }
    }

    const { data: recommendation, error: recError } = await supabase
      .from('recommendations')
      .select('id, account_id, title, description, expected_impact, action_payload, status, created_at')
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
      admin = deps.createAdminClient();
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

    const ctx: ExecutionContext = { req, deps, supabase, admin, user, next };

    if (intent === 'execute') {
      return executeApprovedRecommendation(ctx, recommendation);
    }

    // approve and approve_execute share the approval step verbatim.
    const approvedOk = await approveRecommendation(ctx, recommendation, intent);
    if (!approvedOk) {
      return NextResponse.redirect(new URL(`${next}?error=recommendation_locked`, req.url), 303);
    }

    if (intent === 'approve_execute') {
      // The approval above is the ONLY state change this intent adds. From
      // here the row is `approved` exactly as after a separate approve
      // submit, and the shared execute path re-applies every check
      // (subscription, account scope, preflight, guardrails, claim, quota,
      // validateOnly, fail-closed recording).
      return executeApprovedRecommendation(ctx, { ...recommendation, status: 'approved' });
    }

    return NextResponse.redirect(new URL(`${next}?approved=1`, req.url), 303);
  };
}

type ExecutionContext = {
  req: NextRequest;
  deps: RecommendationActionDependencies;
  supabase: any;
  admin: any;
  user: { id: string; email?: string | null };
  next: string;
};

/**
 * pending|failed -> approved, plus the `approval_queued` audit row. Returns
 * false when the conditional update matched no row (already approved,
 * executing, applied or dismissed), in which case nothing else may run.
 */
async function approveRecommendation(
  { admin, user }: ExecutionContext,
  recommendation: any,
  intent: string
) {
  const { data: approved } = await admin
    .from('recommendations')
    .update({ status: 'approved', applied_by: user.id })
    .eq('id', recommendation.id)
    .eq('account_id', recommendation.account_id)
    .in('status', ['pending', 'failed'])
    .select('id')
    .maybeSingle();

  if (!approved) return false;

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
      ...(intent === 'approve_execute' ? { approved_via: 'approve_execute' } : {}),
    },
    expected_impact: recommendation.expected_impact,
    result: {
      status: 'queued_for_execution',
      note: 'No live Google Ads mutation was executed by this approval action.',
    },
  });
  return true;
}

/**
 * The one execution path for a human-approved recommendation. Both the
 * `execute` and `approve_execute` intents land here; neither has a shortcut.
 */
async function executeApprovedRecommendation(
  { req, deps, supabase, admin, user, next }: ExecutionContext,
  recommendation: any
): Promise<NextResponse> {
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

  // An optimizer budget or bid card is a snapshot of one night's numbers and of
  // that night's one-change-per-week locks. After 7 days it is not executable:
  // the owner gets a clear message and the card leaves the approved list, and
  // the overnight run proposes a fresh one if the change still makes sense.
  // Jarvis and assistant cards are the owner's own request and never expire here.
  if (isExpiredOptimizerMoneyMove(recommendation, action.type)) {
    await markExecutionFailed({
      admin,
      recommendation,
      userId: user.id,
      status: 'recommendation_expired',
      message: 'This optimizer budget or bid recommendation is older than 7 days and can no longer be executed.',
    });
    return NextResponse.redirect(new URL(`${next}?error=recommendation_expired`, req.url), 303);
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

  // The entitlement gate ran at the top of the handler, before the Google Ads
  // preflight, so a lapsed subscriber repeatedly clicking تنفيذ does not spend
  // live Google Ads reads and guardrail aggregation against the shared
  // developer token just to be told no afterwards. The quota reservation further
  // down (consumeFeatureUsage) stays authoritative for the plan's daily limit.

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
    const refreshToken = deps.decrypt(account.refresh_token_encrypted);
    const customer = deps.getCustomer(account.customer_id, refreshToken, account.manager_id ?? undefined);
    const prepared = await deps.prepareActionForExecution(scopedAction, customer);
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

  // An optimizer card was queued days ago under that night's locks. Re-apply the
  // executed-history locks now (minus the rows this card wrote itself), so a
  // budget or target changed since, by Jarvis, by hand or by another card, is
  // not changed again inside its week. Jarvis cards keep their right to change
  // a budget again from chat and pass nothing.
  const guardRejection: { code: string | null } = { code: null };
  const safe = await deps.checkGuardrails(
    preparedAction,
    account.id,
    supabase,
    undefined,
    isOptimizerRecommendation(recommendation)
      ? { recommendationId: recommendation.id, onReject: (rejection) => { guardRejection.code = rejection.code; } }
      : undefined
  );
  if (!safe) {
    const recentChange =
      guardRejection.code === 'budget_locked_recent_change' || guardRejection.code === 'bid_locked_recent_change';
    await markExecutionFailed({
      admin,
      recommendation,
      userId: user.id,
      status: recentChange ? 'recent_change_lock' : 'blocked_by_guardrails',
      message: recentChange
        ? 'The same budget or target was changed recently, so this older recommendation was not executed.'
        : 'Guardrails blocked this action before Google Ads execution.',
    });
    return NextResponse.redirect(
      new URL(`${next}?error=${recentChange ? 'recent_change_lock' : 'blocked_by_guardrails'}`, req.url),
      303
    );
  }

  const executionKey = deps.randomUUID();
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

  const usage = await deps.consumeFeatureUsage({
    supabase,
    userId: user.id,
    userEmail: user.email,
    feature: 'execute_action',
    accountId: account.id,
    metadata: { recommendation_id: recommendation.id, customer_id: account.customer_id },
  });
  if (!usage.ok) {
    await releaseExecutionClaim(admin, recommendation, executionKey);
    return NextResponse.redirect(new URL(`${next}?error=${usage.reason}`, req.url), 303);
  }

  try {
    const refreshToken = deps.decrypt(account.refresh_token_encrypted);
    const customer = deps.getCustomer(account.customer_id, refreshToken, account.manager_id ?? undefined);
    await deps.executeAction(safe, customer, { validateOnly: true });
    let result: unknown;
    try {
      result = await deps.executeAction(safe, customer);
    } catch (mutateError) {
      // A client-side timeout on the LIVE mutate is ambiguous: Google may
      // have committed the change after our 20s deadline. Marking it
      // `failed` (re-executable) risked a duplicate apply of a
      // non-idempotent create. Flag it so the catch below keeps the row
      // locked and asks for manual verification instead.
      if (isAmbiguousGoogleAdsMutationError(mutateError)) {
        liveMutationOutcomeUnknown = true;
      }
      throw mutateError;
    }
    mutationApplied = true;
    const appliedAt = new Date().toISOString();
    const appliedResult: Record<string, unknown> = {
      status: 'applied',
      validate_only: 'passed',
      google_ads_result: result,
    };
    if (isExtendedActionsEnabled() && isExtendedOperation(safe.type)) {
      // The mutate is already live. The readback only reports whether Google shows it; it never throws.
      appliedResult.readback = await readbackExtendedAction(safe, customer);
    }

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
          : 'Google Ads mutation ended with an ambiguous network outcome',
        {
          recommendationId: recommendation.id,
          accountId: account.id,
          executionKey,
          error: operationalError(error),
        }
      );
      await safeExecutionAlert(deps, {
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
          outcome: mutationApplied ? 'applied_recording_failed' : 'unknown_after_network_error',
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

    await deps.refundFeatureUsage({ userId: user.id, usageEventId: usage.usageEventId });
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

async function safeExecutionAlert(
  deps: RecommendationActionDependencies,
  payload: Parameters<typeof sendOpsAlert>[0]
) {
  try {
    await deps.sendOpsAlert(payload);
  } catch (error) {
    console.error('Failed to send recommendation execution alert', operationalError(error));
  }
}

function operationalError(error: unknown) {
  return error instanceof Error
    ? { name: error.name, message: error.message.slice(0, 1000) }
    : { message: String(error).slice(0, 1000) };
}
