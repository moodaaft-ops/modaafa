import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyAutonomyLevel,
  autonomyLevelsEnabled,
  evaluateAutonomy,
  evaluateBudgetShift,
  hardCeilingViolations,
  normalizeAutonomyLevel,
  type AutonomyContext,
  type BudgetChange,
} from '../lib/autopilot/autonomy';
import { buildAutoActionNotice } from '../lib/autopilot/autonomy-notify';
import { evaluateAutopilotPolicy } from '../lib/autopilot/policy';
import { normalizeAutopilotSettings } from '../lib/autopilot/settings';
import type { AutopilotCandidate } from '../lib/autopilot/types';

const settings = { ...normalizeAutopilotSettings('acc', { mode: 'conservative' }) };
const CAMPAIGN = 'customers/123/campaigns/9';
const KEYWORD = 'customers/123/adGroupCriteria/5~6';

function negative(over: Partial<AutopilotCandidate> = {}): AutopilotCandidate {
  return {
    type: 'add_negative_keyword',
    target_id: CAMPAIGN,
    params: { campaign_resource: CAMPAIGN, keyword_text: 'مجاني', match_type: 'EXACT' },
    reason_ar: 'x',
    reason_en: 'x',
    confidence: 0.97,
    evidence: { window_days: 30, clicks: 12, conversions: 0, cost_micros: 90_000_000, relevance: 'clearly_irrelevant' },
    expected_impact: { metric: 'cost', delta_pct: 0, delta_sar_per_month: 0 },
    ...over,
  } as AutopilotCandidate;
}

function pause(): AutopilotCandidate {
  return {
    type: 'pause_keyword',
    target_id: KEYWORD,
    params: {},
    reason_ar: 'x',
    reason_en: 'x',
    confidence: 0.97,
    expected_impact: { metric: 'cost', delta_pct: 0, delta_sar_per_month: 0 },
  } as AutopilotCandidate;
}

const snapshot: any = {
  campaigns: [],
  conversion_tracking: { status: 'healthy' },
  // allowable CPA (cut end) = 40
  economics: { break_even_cpa: 50, break_even_cpa_cut: 40 },
  underperforming_keywords: [
    {
      ad_group_criterion: { resource_name: KEYWORD, keyword: { text: 'x', match_type: 'BROAD' } },
      metrics: { clicks: 30, conversions: 0, cost_micros: 100_000_000 },
    },
  ],
};

function ctx(action: AutopilotCandidate, over: Partial<AutonomyContext> = {}): AutonomyContext {
  return {
    level: 'small_and_notify',
    settings,
    action,
    trackingStatus: 'healthy',
    globalExecutionEnabled: true,
    executedToday: 0,
    sameTargetExecutedWithinCooldown: false,
    snapshot,
    ...over,
  };
}

test('flag is off unless exactly true, unknown levels fall back to ask_all', () => {
  assert.equal(autonomyLevelsEnabled({} as any), false);
  assert.equal(autonomyLevelsEnabled({ AUTONOMY_LEVELS_ENABLED: '1' } as any), false);
  assert.equal(autonomyLevelsEnabled({ AUTONOMY_LEVELS_ENABLED: 'true' } as any), true);
  for (const bad of [undefined, null, '', 'full_auto', 'SMALL_AND_NOTIFY', 3]) {
    assert.equal(normalizeAutonomyLevel(bad), 'ask_all');
  }
  assert.equal(normalizeAutonomyLevel('small_and_notify'), 'small_and_notify');
});

test('small level approves an exact negative at 2x allowable CPA with zero conversions', () => {
  const verdict = evaluateAutonomy(ctx(negative()));
  assert.equal(verdict.outcome, 'execute');
  assert.equal(verdict.code, 'autonomy_approved');
});

test('negative below 2x CPA, with conversions, or not exact is never executed', () => {
  const cheap = negative({ evidence: { window_days: 30, clicks: 12, conversions: 0, cost_micros: 79_000_000, relevance: 'clearly_irrelevant' } });
  assert.notEqual(evaluateAutonomy(ctx(cheap)).outcome, 'execute');
  const converting = negative({ evidence: { window_days: 30, clicks: 12, conversions: 1, cost_micros: 200_000_000, relevance: 'clearly_irrelevant' } });
  assert.notEqual(evaluateAutonomy(ctx(converting)).outcome, 'execute');
  for (const match_type of ['PHRASE', 'BROAD', 'exactish']) {
    const wide = negative({ params: { campaign_resource: CAMPAIGN, keyword_text: 'مجاني', match_type } });
    assert.notEqual(evaluateAutonomy(ctx(wide)).outcome, 'execute', match_type);
  }
});

test('without the owner break-even the account CPA is not a yardstick', () => {
  const verdict = evaluateAutonomy(ctx(negative(), { snapshot: { ...snapshot, economics: null } }));
  assert.equal(verdict.outcome, 'queue');
  assert.equal(verdict.code, 'no_break_even');
});

test('pause_keyword follows the same proof rule, read from the snapshot', () => {
  assert.equal(evaluateAutonomy(ctx(pause())).outcome, 'execute');
  const few = {
    ...snapshot,
    underperforming_keywords: [{ ...snapshot.underperforming_keywords[0], metrics: { clicks: 5, conversions: 0, cost_micros: 100_000_000 } }],
  };
  assert.equal(evaluateAutonomy(ctx(pause(), { snapshot: few })).outcome, 'queue');
  const converting = {
    ...snapshot,
    underperforming_keywords: [{ ...snapshot.underperforming_keywords[0], metrics: { clicks: 30, conversions: 2, cost_micros: 100_000_000 } }],
  };
  assert.equal(evaluateAutonomy(ctx(pause(), { snapshot: converting })).outcome, 'queue');
});

test('every other action type is queued at the small level', () => {
  for (const type of [
    'adjust_budget', 'adjust_bid', 'add_keyword', 'pause_ad', 'pause_campaign',
    'enable_campaign', 'create_campaign', 'add_negative_keywords_batch', 'billing_update', 'policy_exemption',
  ]) {
    const verdict = evaluateAutonomy(ctx({ ...negative(), type: type as any, params: { match_type: 'EXACT' } }));
    assert.notEqual(verdict.outcome, 'execute', type);
  }
});

test('hard ceilings reject targets, billing and policy keys on any action', () => {
  for (const key of ['target_cpa_micros', 'target_roas', 'bidding_strategy', 'billing_setup', 'policy_exemption', 'TARGET_CPA']) {
    const violations = hardCeilingViolations({ type: 'add_negative_keyword', params: { match_type: 'EXACT', [key]: 1 } });
    assert.ok(violations.length > 0, key);
    const verdict = evaluateAutonomy(
      ctx(negative({ params: { campaign_resource: CAMPAIGN, keyword_text: 'x', match_type: 'EXACT', [key]: 1 } }))
    );
    assert.notEqual(verdict.outcome, 'execute', key);
  }
  assert.deepEqual(hardCeilingViolations({ type: 'add_negative_keyword', params: { match_type: 'EXACT' } }), []);
});

test('the level never overrides the kill switch, the mode or tracking', () => {
  assert.equal(evaluateAutonomy(ctx(negative(), { globalExecutionEnabled: false })).outcome, 'queue');
  assert.equal(evaluateAutonomy(ctx(negative(), { settings: { ...settings, mode: 'observe' } })).outcome, 'queue');
  assert.equal(evaluateAutonomy(ctx(negative(), { settings: { ...settings, mode: 'off' } })).outcome, 'queue');
  for (const status of ['missing', 'suspect', 'broken_recently', 'wrong_primary', 'unknown'] as const) {
    assert.equal(evaluateAutonomy(ctx(negative(), { trackingStatus: status })).outcome, 'queue', status);
  }
  assert.equal(evaluateAutonomy(ctx(negative({ confidence: 0.5 }))).outcome, 'queue');
});

test('daily limit and cooldown block', () => {
  assert.equal(evaluateAutonomy(ctx(negative(), { executedToday: 3 })).outcome, 'block');
  assert.equal(evaluateAutonomy(ctx(negative(), { sameTargetExecutedWithinCooldown: true })).outcome, 'block');
});

test('ask_all level downgrades every execute verdict to queue', () => {
  const context = ctx(negative(), { level: 'ask_all' });
  const base = evaluateAutopilotPolicy(context);
  assert.equal(base.outcome, 'execute');
  const verdict = applyAutonomyLevel(base, context);
  assert.equal(verdict.outcome, 'queue');
  assert.equal(verdict.code, 'autonomy_ask_all');
  assert.equal(evaluateAutonomy(context).outcome, 'queue');
});

test('small level keeps the old switches: off and observe stay as they were', () => {
  for (const mode of ['off', 'observe'] as const) {
    const context = ctx(negative(), { settings: { ...settings, mode } });
    const base = evaluateAutopilotPolicy(context);
    assert.deepEqual(applyAutonomyLevel(base, context), base);
  }
});

test('small level can approve a pause the older gate would have queued', () => {
  const context = ctx(pause());
  const base = evaluateAutopilotPolicy(context);
  assert.equal(base.outcome, 'queue');
  assert.equal(applyAutonomyLevel(base, context).outcome, 'execute');
});

// -- budget shift: property style ------------------------------------------------

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function randomChanges(next: () => number): BudgetChange[] {
  const n = 2 + Math.floor(next() * 4);
  return Array.from({ length: n }, (_, i) => {
    const current = Math.round((5 + next() * 500) * 1_000_000);
    const factor = 0.7 + next() * 0.6;
    return {
      budget_resource: `customers/1/campaignBudgets/${i}`,
      current_amount_micros: current,
      new_amount_micros: Math.max(1, Math.round(current * factor)),
    };
  });
}

test('property: a budget move that raises the total is never accepted', () => {
  const next = rng(42);
  let accepted = 0;
  for (let i = 0; i < 5000; i++) {
    const changes = randomChanges(next);
    const before = changes.reduce((sum, c) => sum + c.current_amount_micros, 0);
    const after = changes.reduce((sum, c) => sum + c.new_amount_micros, 0);
    const verdict = evaluateBudgetShift(changes);
    if (verdict.ok) {
      accepted++;
      assert.ok(after <= before, 'accepted a raise');
      for (const c of changes) {
        assert.ok(Math.abs(c.new_amount_micros - c.current_amount_micros) <= before * 0.1 + 1e-6);
      }
    }
    if (after > before) assert.equal(verdict.ok, false);
  }
  assert.ok(accepted > 0, 'the generator should produce some valid shifts');
});

test('budget shift: one micro over the old total is a raise, equal total passes', () => {
  const base: BudgetChange[] = [
    { budget_resource: 'a', current_amount_micros: 100_000_000, new_amount_micros: 95_000_000 },
    { budget_resource: 'b', current_amount_micros: 100_000_000, new_amount_micros: 105_000_000 },
  ];
  assert.equal(evaluateBudgetShift(base).ok, true);
  const raised = [base[0], { ...base[1], new_amount_micros: 105_000_001 }];
  assert.deepEqual(evaluateBudgetShift(raised), { ok: false, code: 'raises_total_spend' });
});

test('budget shift: too large, one-sided, duplicated or malformed moves are rejected', () => {
  const big: BudgetChange[] = [
    { budget_resource: 'a', current_amount_micros: 100_000_000, new_amount_micros: 70_000_000 },
    { budget_resource: 'b', current_amount_micros: 100_000_000, new_amount_micros: 130_000_000 },
  ];
  assert.deepEqual(evaluateBudgetShift(big), { ok: false, code: 'shift_too_large' });
  const oneSided: BudgetChange[] = [
    { budget_resource: 'a', current_amount_micros: 100_000_000, new_amount_micros: 95_000_000 },
    { budget_resource: 'b', current_amount_micros: 100_000_000, new_amount_micros: 100_000_000 },
  ];
  assert.equal(evaluateBudgetShift(oneSided).ok, false);
  const dup = [oneSided[0], { ...oneSided[0], new_amount_micros: 105_000_000 }];
  assert.equal(evaluateBudgetShift(dup).ok, false);
  assert.equal(evaluateBudgetShift([]).ok, false);
  assert.equal(evaluateBudgetShift([oneSided[0]]).ok, false);
  assert.equal(evaluateBudgetShift([{ budget_resource: 'a', current_amount_micros: NaN, new_amount_micros: 1 }, oneSided[0]]).ok, false);
});

test('property: random actions never execute outside the two small types', () => {
  const next = rng(7);
  const types = ['pause_keyword', 'add_negative_keyword', 'adjust_budget', 'adjust_bid', 'enable_campaign', 'add_keyword', 'pause_ad'];
  for (let i = 0; i < 500; i++) {
    const type = types[Math.floor(next() * types.length)];
    const action = { ...negative(), type, params: { match_type: 'EXACT', campaign_resource: CAMPAIGN, keyword_text: 'x', delta_pct: 10 } } as any;
    const verdict = evaluateAutonomy(ctx(action));
    if (verdict.outcome === 'execute') assert.ok(['pause_keyword', 'add_negative_keyword'].includes(type));
  }
});

test('notice: Arabic, with the undo path and no dashes', () => {
  const mail = buildAutoActionNotice({
    actionType: 'add_negative_keyword',
    subject: 'مجاني',
    campaignName: 'مكيفات',
    reasonAr: 'صرفت وما جابت شي.',
    appUrl: 'https://ai.modaafa.com/',
  });
  assert.match(mail.text, /تراجع/);
  assert.equal(mail.undoUrl, 'https://ai.modaafa.com/home');
  assert.doesNotMatch(mail.text + mail.subject, /[–—]/);
});
