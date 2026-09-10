import assert from 'node:assert/strict';
import test from 'node:test';
import { actionHistoryLabel, actionHistoryState } from '../lib/guidance/action-history';

test('approval is distinct from a live Google Ads change', () => {
  const state = actionHistoryState({
    action_type: 'approval_queued',
    result: { status: 'queued_for_execution' },
  });
  assert.equal(state, 'approved');
  assert.equal(actionHistoryLabel(state), 'معتمد وينتظر التنفيذ');
});

test('measured actions and reverted actions get explicit states', () => {
  assert.equal(
    actionHistoryState({ action_type: 'adjust_budget', observed_impact: { before: { cost: 100, conversions: 1 }, after: { cost: 60, conversions: 1 }, delta: { cost: -40 } } }),
    'measured'
  );
  assert.equal(
    actionHistoryState({
      action_type: 'adjust_budget',
      observed_impact: { before: { cost: 100, conversions: 1 }, after: { cost: 60, conversions: 1 }, delta: { cost: -40 } },
      reverted_at: '2026-08-24T10:00:00.000Z',
    }),
    'reverted'
  );
});

test('blocked and failed actions are never presented as executed', () => {
  assert.equal(
    actionHistoryState({ action_type: 'execution_blocked', result: { status: 'manual_review_required' } }),
    'failed'
  );
});

test('a live action without impact waits for measurement', () => {
  assert.equal(actionHistoryState({ action_type: 'pause_keyword', result: { status: 'success' } }), 'awaiting_measurement');
});

test('partial or unmeasurable payloads cannot claim measured success', () => {
  assert.equal(actionHistoryState({ observed_impact: { delta: { cost: -40 } } }), 'limited');
  assert.equal(actionHistoryState({ observed_impact: { status: 'unmeasurable' } }), 'unmeasurable');
  assert.equal(actionHistoryState({ result: { status: 'mutation_outcome_unknown' } }), 'executing');
});
