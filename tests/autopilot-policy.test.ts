import assert from 'node:assert/strict';
import test from 'node:test';
import type { OptimizerSnapshot } from '../lib/ai/optimizer-agent';
import {
  autopilotTargetKey,
  evaluateAutopilotPolicy,
  groundAutopilotCandidate,
} from '../lib/autopilot/policy';
import type {
  AutopilotCandidate,
  AutopilotPolicyContext,
  AutopilotSettings,
} from '../lib/autopilot/types';

const settings: AutopilotSettings = {
  account_id: 'account-1',
  mode: 'conservative',
  allowed_actions: ['add_negative_keyword'],
  max_daily_changes: 3,
  min_confidence: 0.95,
  cooldown_hours: 48,
  require_healthy_tracking: true,
  anomaly_pause_enabled: true,
  config_version: 1,
  terms_accepted_at: '2026-08-25T00:00:00.000Z',
  paused_at: null,
  pause_reason: null,
  last_run_at: null,
};

const safeAction: AutopilotCandidate = {
  type: 'add_negative_keyword',
  target_id: 'customers/123/campaigns/456',
  params: {
    campaign_resource: 'customers/123/campaigns/456',
    keyword_text: 'وظائف مجانية',
    match_type: 'EXACT',
  },
  reason_ar: 'بحث عن وظيفة لا علاقة له بالخدمة المعلنة.',
  reason_en: 'Clearly irrelevant employment query.',
  confidence: 0.98,
  evidence: {
    window_days: 30,
    clicks: 12,
    conversions: 0,
    cost_micros: 8_000_000,
    source_resource: 'customers/123/campaigns/456',
    relevance: 'clearly_irrelevant',
  },
  expected_impact: {
    metric: 'wasted_spend',
    delta_pct: -5,
    delta_sar_per_month: 8,
  },
};

function context(overrides: Partial<AutopilotPolicyContext> = {}): AutopilotPolicyContext {
  return {
    settings,
    action: safeAction,
    trackingStatus: 'healthy',
    globalExecutionEnabled: true,
    executedToday: 0,
    sameTargetExecutedWithinCooldown: false,
    ...overrides,
  };
}

test('conservative autopilot executes only an exact negative with grounded evidence', () => {
  assert.equal(evaluateAutopilotPolicy(context()).outcome, 'execute');
});

test('off and observe modes can only queue recommendations', () => {
  assert.equal(
    evaluateAutopilotPolicy(context({ settings: { ...settings, mode: 'off' } })).code,
    'autopilot_off'
  );
  assert.equal(
    evaluateAutopilotPolicy(context({ settings: { ...settings, mode: 'observe' } })).code,
    'observe_only'
  );
});

test('the operator kill switch and an unavailable history ledger fail closed', () => {
  const verdict = evaluateAutopilotPolicy(context({ globalExecutionEnabled: false }));
  assert.equal(verdict.outcome, 'queue');
  assert.equal(verdict.code, 'global_execution_disabled');
});

test('unsupported actions always require human review', () => {
  const action: AutopilotCandidate = {
    ...safeAction,
    type: 'adjust_budget',
    params: { budget_resource: 'customers/123/campaignBudgets/456', delta_pct: 10 },
  };
  const verdict = evaluateAutopilotPolicy(context({ action }));
  assert.equal(verdict.outcome, 'queue');
  assert.equal(verdict.code, 'manual_action_type');
});

test('tracking anomalies, weak evidence, daily limits and cooldowns prevent execution', () => {
  assert.equal(
    evaluateAutopilotPolicy(context({ trackingStatus: 'suspect' })).code,
    'anomaly_pause'
  );
  assert.equal(
    evaluateAutopilotPolicy(
      context({ action: { ...safeAction, evidence: { ...safeAction.evidence!, clicks: 2 } } })
    ).code,
    'insufficient_evidence'
  );
  assert.equal(
    evaluateAutopilotPolicy(context({ executedToday: settings.max_daily_changes })).code,
    'daily_limit_reached'
  );
  assert.equal(
    evaluateAutopilotPolicy(context({ sameTargetExecutedWithinCooldown: true })).code,
    'target_in_cooldown'
  );
});

test('grounding replaces model-supplied numbers with the matching Google Ads row', () => {
  const snapshot = {
    wasted_search_terms: [
      {
        campaign: { resourceName: 'customers/123/campaigns/456' },
        searchTermView: { searchTerm: 'وظائف مجانية' },
        metrics: { clicks: '9', conversions: '0', costMicros: '6500000' },
      },
    ],
  } as unknown as OptimizerSnapshot;
  const grounded = groundAutopilotCandidate(
    {
      ...safeAction,
      evidence: { ...safeAction.evidence!, clicks: 999, cost_micros: 999_000_000 },
    },
    snapshot
  );

  assert.equal(grounded.evidence?.clicks, 9);
  assert.equal(grounded.evidence?.cost_micros, 6_500_000);
  assert.equal(grounded.evidence?.conversions, 0);
});

test('missing source evidence cannot pass through from the model', () => {
  const grounded = groundAutopilotCandidate(
    safeAction,
    { wasted_search_terms: [] } as unknown as OptimizerSnapshot
  );
  assert.equal(grounded.evidence, undefined);
  assert.equal(
    evaluateAutopilotPolicy(context({ action: grounded })).code,
    'insufficient_evidence'
  );
});

test('target keys are stable per normalized keyword and distinct across keywords', () => {
  const first = autopilotTargetKey(safeAction);
  const normalized = autopilotTargetKey({
    ...safeAction,
    params: { ...safeAction.params, keyword_text: '  وظائف   مجانية  ' },
  });
  const different = autopilotTargetKey({
    ...safeAction,
    params: { ...safeAction.params, keyword_text: 'وظائف عن بعد' },
  });
  assert.equal(first, normalized);
  assert.notEqual(first, different);
});
