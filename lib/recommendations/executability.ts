import { buildExecutableAction } from '@/lib/ai/executable-action';
import { growthOperationEnabled, isGrowthOperation } from '@/lib/growth/flags';

/**
 * Whether «اعتمد» on this recommendation can end in a real Google Ads change.
 *
 * Descriptive advice (diagnose_zero_spend_campaigns, setup_conversion_tracking,
 * review_* …) has no executable payload: approving it used to flip the row to
 * `approved`, then the execute step logged `execution_blocked` and the card sat
 * in «وافقت عليه، باقي التنفيذ» forever. Every surface that offers «اعتمد» and
 * the approve route itself ask this one question, so the button and the server
 * can never disagree.
 *
 * Mirrors the preliminary check at the top of executeApprovedRecommendation;
 * the full check (with the account's customer id, preflight and guardrails)
 * still runs at execution time.
 */
export function isRecommendationExecutable(recommendation: {
  action_payload?: any;
  [key: string]: unknown;
} | null | undefined): boolean {
  const payload = recommendation?.action_payload;
  if (!payload) return false;
  const operation = payload.operation;
  if (isGrowthOperation(operation) && growthOperationEnabled(operation)) return true;
  return Boolean(buildExecutableAction(payload, recommendation));
}
