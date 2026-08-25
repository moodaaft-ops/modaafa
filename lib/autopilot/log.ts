import {
  AUTOPILOT_POLICY_VERSION,
  type AutopilotCandidate,
  type AutopilotDecision,
  type AutopilotMode,
  type AutopilotPolicyVerdict,
} from './types';
import { autopilotTargetKey } from './policy';

export async function recordAutopilotDecision({
  supabase,
  accountId,
  jobRunId,
  recommendationId,
  aiActionId,
  mode,
  action,
  decision,
  verdict,
  googleValidation,
  reasonAr,
  metadata,
}: {
  supabase: any;
  accountId: string;
  jobRunId?: string | null;
  recommendationId?: string | null;
  aiActionId?: string | null;
  mode: AutopilotMode;
  action?: AutopilotCandidate | null;
  decision: AutopilotDecision;
  verdict?: AutopilotPolicyVerdict | null;
  googleValidation?: Record<string, unknown> | null;
  reasonAr?: string | null;
  metadata?: Record<string, unknown> | null;
}) {
  const actionSnapshot = action
    ? { ...action, ...(metadata ? { metadata } : {}) }
    : metadata ?? {};

  const { error } = await supabase.from('autopilot_decisions').insert({
    account_id: accountId,
    job_run_id: jobRunId ?? null,
    recommendation_id: recommendationId ?? null,
    ai_action_id: aiActionId ?? null,
    mode,
    action_type: action?.type ?? null,
    target_id: action ? autopilotTargetKey(action) : null,
    decision,
    policy_version: AUTOPILOT_POLICY_VERSION,
    confidence: action?.confidence ?? null,
    reason_ar: reasonAr ?? verdict?.reason_ar ?? action?.reason_ar ?? null,
    action_snapshot: actionSnapshot,
    policy_checks: verdict
      ? { outcome: verdict.outcome, code: verdict.code, checks: verdict.checks }
      : {},
    google_validation: googleValidation ?? {},
  });

  if (error) throw error;
}
