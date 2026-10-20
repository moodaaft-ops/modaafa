import { validateMatchUpload } from '../audiences/match-action';
import type { OptimizerAction } from '../ai/optimizer-agent';
import { GROWTH_LABELS_AR, growthOperationEnabled, isGrowthOperation, type GrowthOperation } from './flags';
import { validateStoredDemandGenPlan } from '../demand-gen/validate';
import { validateAttachAudienceParams, validateCreateUserListParams } from '../audiences/user-lists';
import { validateStoredExperimentPlan } from '../experiments/plan';
import { validateEndParams, validatePromoteParams } from '../experiments/execute';
import { validateCreateImageAssetsParams } from '../image-assets/execute';

/**
 * One boundary for the four growth flags (DEMAND_GEN_ENABLED, AUDIENCES_ENABLED, EXPERIMENTS_ENABLED,
 * IMAGE_ASSETS_ENABLED). Everything here returns null / is skipped when the operation's flag is off,
 * so with all four off the approval pipeline behaves exactly as before.
 *
 * This file must not import the executors' network code or execution-preflight (that one imports us).
 */

export const GROWTH_RESULT_ROLLBACK = 'growth_result_rollback';

/** Rebuilds an executable action from a stored card. Only the validated, re-derived params are kept. */
export function buildGrowthAction(payload: any, recommendation: any, accountCustomerId?: string | null): OptimizerAction | null {
  const operation = String(payload?.operation ?? '');
  if (!isGrowthOperation(operation) || !growthOperationEnabled(operation)) return null;
  const customerId = String(accountCustomerId ?? '').replace(/\D/g, '');
  if (!customerId) return null;
  const params = payload?.params;
  let clean: Record<string, unknown> | null = null;

  switch (operation as GrowthOperation) {
    case 'launch_demand_gen': {
      const checked = validateStoredDemandGenPlan(params?.plan, customerId);
      if (checked.ok) clean = { plan: checked.plan };
      break;
    }
    case 'upload_customer_match': {
      const checked = validateMatchUpload(params, customerId);
      if (checked && typeof recommendation?.account_id === 'string') clean = { ...checked, account_id: recommendation.account_id };
      break;
    }
    case 'create_user_list': {
      const checked = validateCreateUserListParams(params);
      if (checked.ok) clean = { ...checked.value };
      break;
    }
    case 'attach_audience': {
      const checked = validateAttachAudienceParams(params, customerId);
      if (checked.ok) clean = { ...checked.value };
      break;
    }
    case 'create_experiment': {
      const checked = validateStoredExperimentPlan(params?.plan, customerId);
      if (checked.ok) clean = { plan: checked.plan };
      break;
    }
    case 'end_experiment': {
      const checked = validateEndParams(params, customerId);
      if (checked.ok) clean = { ...checked.value };
      break;
    }
    case 'promote_experiment': {
      const checked = validatePromoteParams(params, customerId);
      if (checked.ok) clean = { ...checked.value };
      break;
    }
    case 'create_image_assets': {
      const checked = validateCreateImageAssetsParams(params);
      if (checked.ok) clean = { images: checked.value.images };
      break;
    }
  }
  if (!clean) return null;
  return {
    type: operation,
    target_id: '',
    params: { ...clean, customer_id: customerId },
    reason_ar: recommendation?.description ?? recommendation?.title,
    reason_en: recommendation?.title,
    expected_impact: { metric: 'performance', delta_pct: 0, delta_sar_per_month: 0 },
  } as OptimizerAction;
}

/** The created resources only exist after the call, so the rollback is filled from its result. */
export function prepareGrowthAction(action: OptimizerAction) {
  return {
    action: { ...action, params: { ...action.params } } as OptimizerAction,
    rollbackPayload: { reversible: true, action_type: GROWTH_RESULT_ROLLBACK, growth_result_rollback: true } as Record<string, unknown>,
    measurement: null,
  };
}

export function isGrowthPlaceholderRollback(payload: Record<string, unknown>) {
  return payload.action_type === GROWTH_RESULT_ROLLBACK;
}

export function finalizeGrowthRollback(_payload: Record<string, unknown>, result: any) {
  const built = result?.rollback_payload;
  return built && typeof built === 'object'
    ? built
    : { reversible: false, resource_names: [], note: 'created_resources_unavailable' };
}

export const growthLabelAr = (operation: string) => (isGrowthOperation(operation) ? GROWTH_LABELS_AR[operation] : null);
