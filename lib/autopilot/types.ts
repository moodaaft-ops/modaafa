import type { ConversionTrackingStatus, OptimizerAction } from '@/lib/ai/optimizer-agent';

export const AUTOPILOT_MODES = ['off', 'observe', 'conservative'] as const;
export type AutopilotMode = (typeof AUTOPILOT_MODES)[number];

export const AUTOPILOT_DECISIONS = [
  'settings_changed',
  'observed',
  'queued',
  'executed',
  'unverified',
  'blocked',
  'failed',
  'no_action',
] as const;
export type AutopilotDecision = (typeof AUTOPILOT_DECISIONS)[number];

/**
 * Versioned independently from the model prompt. A historical decision must
 * always say which deterministic policy approved or blocked it.
 */
export const AUTOPILOT_POLICY_VERSION = '2026-08-25-v1';

/** V1 deliberately automates the smallest reversible surface only. */
export const AUTOPILOT_SAFE_ACTIONS = ['add_negative_keyword'] as const;
export type AutopilotSafeAction = (typeof AUTOPILOT_SAFE_ACTIONS)[number];

export type AutopilotSettings = {
  account_id: string;
  mode: AutopilotMode;
  allowed_actions: string[];
  max_daily_changes: number;
  min_confidence: number;
  cooldown_hours: number;
  require_healthy_tracking: boolean;
  anomaly_pause_enabled: boolean;
  config_version: number;
  terms_accepted_at: string | null;
  paused_at: string | null;
  pause_reason: string | null;
  last_run_at: string | null;
};

export type AutopilotEvidence = {
  window_days: number;
  clicks: number;
  conversions: number;
  cost_micros: number;
  source_resource?: string | null;
  relevance: 'clearly_irrelevant' | 'uncertain';
};

export type AutopilotCandidate = OptimizerAction & {
  confidence?: number;
  evidence?: AutopilotEvidence;
};

export type AutopilotPolicyContext = {
  settings: AutopilotSettings;
  action: AutopilotCandidate;
  trackingStatus: ConversionTrackingStatus;
  globalExecutionEnabled: boolean;
  executedToday: number;
  sameTargetExecutedWithinCooldown: boolean;
};

export type AutopilotPolicyCheck = {
  code: string;
  passed: boolean;
  detail: string;
};

export type AutopilotPolicyVerdict = {
  outcome: 'execute' | 'queue' | 'block';
  code: string;
  reason_ar: string;
  checks: AutopilotPolicyCheck[];
};

export const DEFAULT_AUTOPILOT_SETTINGS: Omit<AutopilotSettings, 'account_id'> = {
  mode: 'off',
  allowed_actions: ['add_negative_keyword'],
  max_daily_changes: 3,
  min_confidence: 0.95,
  cooldown_hours: 48,
  require_healthy_tracking: true,
  anomaly_pause_enabled: true,
  config_version: 1,
  terms_accepted_at: null,
  paused_at: null,
  pause_reason: null,
  last_run_at: null,
};

export function autopilotExecutionGloballyEnabled() {
  return process.env.AUTOPILOT_EXECUTION_ENABLED === 'true';
}
