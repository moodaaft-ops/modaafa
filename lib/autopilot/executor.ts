import { randomUUID } from 'node:crypto';
import type { AutopilotCandidate, AutopilotPolicyVerdict } from './types';
import { autopilotPolicyMetadata } from './policy';
import { buildExecutableAction } from '@/lib/ai/executable-action';
import {
  isAmbiguousGoogleAdsMutationError,
  prepareActionForExecution,
  type MeasurementDescriptor,
} from '@/lib/ai/execution-preflight';
import { checkGuardrails, executeAction } from '@/lib/ai/optimizer-agent';
import { refundFeatureUsage } from '@/lib/billing/entitlements';
import { sendOpsAlert } from '@/lib/notifications/email';
import { findBlockingAutopilotRecommendation } from './recommendation-dedupe';

export type AutopilotExecutionResult = {
  status: 'executed' | 'duplicate' | 'failed' | 'unverified';
  recommendationId?: string | null;
  aiActionId?: string | null;
  validateOnlyPassed?: boolean;
  message?: string;
};

/**
 * Execute one policy-approved action. V1 callers may only pass the exact
 * negative-keyword action allowed by the deterministic policy gate.
 */
export async function executeAutopilotAction({
  supabase,
  customer,
  accountId,
  customerId,
  action,
  verdict,
  fingerprint,
  ownerUserId,
  usageEventId,
}: {
  supabase: any;
  customer: any;
  accountId: string;
  customerId: string;
  action: AutopilotCandidate;
  verdict: AutopilotPolicyVerdict;
  fingerprint: string;
  ownerUserId: string;
  usageEventId?: string | null;
}): Promise<AutopilotExecutionResult> {
  let existing;
  try {
    existing = await findBlockingAutopilotRecommendation(supabase, accountId, fingerprint);
  } catch (error) {
    await refundFeatureUsage({ userId: ownerUserId, usageEventId });
    return {
      status: 'failed',
      message: `Unable to verify autopilot idempotency: ${errorText(error)}`,
    };
  }
  if (existing) {
    await refundFeatureUsage({ userId: ownerUserId, usageEventId });
    return { status: 'duplicate', recommendationId: existing.id };
  }

  const executionKey = randomUUID();
  const actionPayload = {
    operation: action.type,
    target_id: action.target_id,
    params: action.params,
    source: 'autopilot_cron',
    autopilot: autopilotPolicyMetadata(verdict),
    confidence: action.confidence ?? null,
    evidence: action.evidence ?? null,
  };
  const { data: recommendation, error: recommendationError } = await supabase
    .from('recommendations')
    .insert({
      account_id: accountId,
      fingerprint,
      category: categoryForAction(action.type),
      severity: severityForAction(action),
      title: action.reason_ar.slice(0, 120),
      description: action.reason_ar,
      expected_impact: action.expected_impact,
      action_payload: actionPayload,
      status: 'executing',
      execution_key: executionKey,
      execution_started_at: new Date().toISOString(),
      applied_by: 'autopilot',
    })
    .select('id, title, description, expected_impact')
    .maybeSingle();

  if (recommendationError || !recommendation) {
    await refundFeatureUsage({ userId: ownerUserId, usageEventId });
    if (recommendationError?.code === '23505') {
      try {
        const duplicate = await findBlockingAutopilotRecommendation(
          supabase,
          accountId,
          fingerprint
        );
        return { status: 'duplicate', recommendationId: duplicate?.id ?? null };
      } catch (error) {
        return {
          status: 'failed',
          message: `Unable to resolve an autopilot reservation race: ${errorText(error)}`,
        };
      }
    }
    return {
      status: 'failed',
      message: recommendationError?.message ?? 'Unable to reserve autopilot recommendation',
    };
  }

  let preparedAction: AutopilotCandidate;
  let rollbackPayload: Record<string, unknown>;
  let measurement: MeasurementDescriptor | null;
  try {
    const executable = buildExecutableAction(
      actionPayload,
      {
        title: recommendation.title,
        description: recommendation.description,
        expected_impact: recommendation.expected_impact,
      },
      customerId
    );
    if (!executable || executable.type !== 'add_negative_keyword') {
      throw new Error('Autopilot action failed the account-scoped executable-action boundary');
    }
    const prepared = await prepareActionForExecution(
      { ...executable, confidence: action.confidence, evidence: action.evidence } as AutopilotCandidate,
      customer
    );
    preparedAction = prepared.action as AutopilotCandidate;
    rollbackPayload = prepared.rollbackPayload;
    measurement = prepared.measurement;

    const guarded = await checkGuardrails(preparedAction, accountId, supabase);
    if (!guarded) throw new Error('Autopilot action was blocked by execution guardrails');
    preparedAction = guarded as AutopilotCandidate;
  } catch (error) {
    await markFailed(supabase, recommendation.id, accountId, executionKey, error);
    await refundFeatureUsage({ userId: ownerUserId, usageEventId });
    return { status: 'failed', recommendationId: recommendation.id, message: errorText(error) };
  }

  try {
    await executeAction(preparedAction, customer, { validateOnly: true });
  } catch (error) {
    await markFailed(supabase, recommendation.id, accountId, executionKey, error, 'validation_failed');
    await refundFeatureUsage({ userId: ownerUserId, usageEventId });
    return {
      status: 'failed',
      recommendationId: recommendation.id,
      validateOnlyPassed: false,
      message: errorText(error),
    };
  }

  let result: unknown;
  try {
    result = await executeAction(preparedAction, customer);
  } catch (error) {
    if (isAmbiguousGoogleAdsMutationError(error)) {
      await safeAlert({
        subject: 'نتيجة تعديل الطيار الآلي غير مؤكدة',
        message:
          'انتهى الاتصال بعد إرسال التعديل إلى Google Ads. تُرك القرار مقفلاً ومنعنا إعادة المحاولة التلقائية حتى تتم المطابقة اليدوية.',
        details: {
          account_id: accountId,
          recommendation_id: recommendation.id,
          execution_key: executionKey,
          action_type: preparedAction.type,
          outcome: 'unknown_after_network_error',
          error: operationalError(error),
        },
      });
      return {
        status: 'unverified',
        recommendationId: recommendation.id,
        validateOnlyPassed: true,
        message: errorText(error),
      };
    }

    await markFailed(supabase, recommendation.id, accountId, executionKey, error);
    await refundFeatureUsage({ userId: ownerUserId, usageEventId });
    return {
      status: 'failed',
      recommendationId: recommendation.id,
      validateOnlyPassed: true,
      message: errorText(error),
    };
  }

  const appliedResult = {
    status: 'applied',
    validate_only: 'passed',
    google_ads_result: result,
    autopilot: autopilotPolicyMetadata(verdict),
  };
  const { data: actionLog, error: actionLogError } = await supabase
    .from('ai_actions')
    .insert({
      account_id: accountId,
      recommendation_id: recommendation.id,
      execution_key: executionKey,
      action_type: preparedAction.type,
      description_ar: recommendation.description ?? recommendation.title,
      description_en: preparedAction.reason_en,
      reason: preparedAction.reason_en,
      payload: {
        recommendation_id: recommendation.id,
        action: preparedAction,
        measurement: finalizeMeasurement(measurement, result),
        autopilot: autopilotPolicyMetadata(verdict),
      },
      rollback_payload: finalizeRollbackPayload(rollbackPayload, result),
      result: appliedResult,
      expected_impact: recommendation.expected_impact,
    })
    .select('id')
    .maybeSingle();

  if (actionLogError || !actionLog) {
    await safeAlert({
      subject: 'تعديل الطيار الآلي يحتاج مطابقة يدوية',
      message:
        'نجح تعديل Google Ads لكن تعذر حفظ سجل التنفيذ. تُركت التوصية مقفلة لمنع تكرار التعديل.',
      details: {
        account_id: accountId,
        recommendation_id: recommendation.id,
        execution_key: executionKey,
        outcome: 'applied_recording_failed',
        error: operationalError(actionLogError),
      },
    });
    return {
      status: 'unverified',
      recommendationId: recommendation.id,
      validateOnlyPassed: true,
      message: actionLogError?.message ?? 'Action log row was not returned',
    };
  }

  const { data: applied, error: appliedError } = await supabase
    .from('recommendations')
    .update({
      status: 'applied',
      applied_at: new Date().toISOString(),
      applied_by: 'autopilot',
      applied_result: appliedResult,
    })
    .eq('id', recommendation.id)
    .eq('account_id', accountId)
    .eq('execution_key', executionKey)
    .eq('status', 'executing')
    .select('id')
    .maybeSingle();

  if (appliedError || !applied) {
    await safeAlert({
      subject: 'سجل توصية الطيار الآلي يحتاج مطابقة',
      message:
        'نجح تعديل Google Ads وحُفظ سجل الإجراء، لكن تعذر تحديث حالة التوصية. لا تعِد التنفيذ قبل المطابقة.',
      details: {
        account_id: accountId,
        recommendation_id: recommendation.id,
        ai_action_id: actionLog.id,
        execution_key: executionKey,
        error: operationalError(appliedError),
      },
    });
    return {
      status: 'unverified',
      recommendationId: recommendation.id,
      aiActionId: actionLog.id,
      validateOnlyPassed: true,
      message: appliedError?.message ?? 'Recommendation state was not updated',
    };
  }

  return {
    status: 'executed',
    recommendationId: recommendation.id,
    aiActionId: actionLog.id,
    validateOnlyPassed: true,
  };
}

async function markFailed(
  supabase: any,
  recommendationId: string,
  accountId: string,
  executionKey: string,
  error: unknown,
  status = 'execution_failed'
) {
  await supabase
    .from('recommendations')
    .update({
      status: 'failed',
      applied_by: 'autopilot',
      applied_result: { status, message: errorText(error) },
    })
    .eq('id', recommendationId)
    .eq('account_id', accountId)
    .eq('execution_key', executionKey)
    .eq('status', 'executing');
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

function categoryForAction(type: string) {
  if (['pause_keyword', 'add_negative_keyword', 'add_keyword'].includes(type)) return 'keywords';
  if (type === 'adjust_budget') return 'budget';
  if (type === 'adjust_bid') return 'bidding';
  if (type === 'pause_ad') return 'ads';
  return 'structure';
}

function severityForAction(action: { expected_impact?: { delta_sar_per_month?: number } }) {
  const impact = Number(action.expected_impact?.delta_sar_per_month ?? 0);
  if (impact >= 1000) return 'critical';
  if (impact >= 250) return 'medium';
  return 'growth';
}

async function safeAlert(payload: Parameters<typeof sendOpsAlert>[0]) {
  try {
    await sendOpsAlert(payload);
  } catch (error) {
    console.error('Failed to send autopilot execution alert', operationalError(error));
  }
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function operationalError(error: unknown) {
  return error instanceof Error
    ? { name: error.name, message: error.message.slice(0, 1000) }
    : { message: String(error).slice(0, 1000) };
}
