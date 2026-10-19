import type { OptimizerAction } from '../ai/optimizer-agent';
import { campaignLaunchEnabled, LAUNCH_OPERATION } from './flag';
import { validateStoredPlan } from './validate';

/**
 * Turns an approved «ابنِ الحملة موقوفة» card into an executable action.
 * Returns null (manual review) when the flag is off, the plan fails its
 * checks, or the plan is not a PAUSED build. The plan is rebuilt from the
 * stored data only; nothing in `params` besides `plan` is used.
 */
export function buildLaunchAction(
  payload: any,
  recommendation: any,
  accountCustomerId?: string | null
): OptimizerAction | null {
  if (payload?.operation !== LAUNCH_OPERATION || !campaignLaunchEnabled()) return null;
  const checked = validateStoredPlan(payload?.params?.plan);
  if (!checked.ok) return null;
  const customerId = String(accountCustomerId ?? '').replace(/\D/g, '');
  return {
    type: 'launch_campaign',
    target_id: '',
    params: { plan: checked.plan, ...(customerId ? { customer_id: customerId } : {}) },
    reason_ar: recommendation.description ?? recommendation.title,
    reason_en: recommendation.title,
    expected_impact: {
      metric: 'performance',
      delta_pct: 0,
      delta_sar_per_month: 0,
    },
  };
}
