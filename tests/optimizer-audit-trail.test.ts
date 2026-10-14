import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  TRACKING_VERDICTS,
  emptyReasonTally,
  emptyTrackingVerdictCounts,
  tallyReason,
  tallyTrackingVerdict,
} from '../lib/ai/optimizer-audit-trail';

test('every conversion tracking verdict has a counter that starts at zero', () => {
  assert.deepEqual(TRACKING_VERDICTS, ['healthy', 'suspect', 'missing', 'wrong_primary', 'broken_recently', 'unknown']);
  assert.deepEqual(emptyTrackingVerdictCounts(), {
    healthy: 0,
    suspect: 0,
    missing: 0,
    wrong_primary: 0,
    broken_recently: 0,
    unknown: 0,
  });
});

test('accounts are counted once under their verdict; anything unreadable counts as unknown', () => {
  const counts = emptyTrackingVerdictCounts();
  for (const status of ['healthy', 'healthy', 'suspect', 'missing', 'wrong_primary', 'broken_recently', undefined, null, 'surprise']) {
    tallyTrackingVerdict(counts, status);
  }
  assert.deepEqual(counts, { healthy: 2, suspect: 1, missing: 1, wrong_primary: 1, broken_recently: 1, unknown: 3 });
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), 9);
});

test('refusals are counted by reason and by action type', () => {
  const tally = emptyReasonTally();
  tallyReason(tally, { code: 'tracking_not_healthy', action_type: 'adjust_budget' });
  tallyReason(tally, { code: 'tracking_not_healthy', action_type: 'pause_keyword' });
  tallyReason(tally, { code: 'budget_locked_pending', action_type: 'adjust_budget' });
  tallyReason(tally, { code: '', action_type: null });
  assert.deepEqual(tally, {
    total: 4,
    by_reason: { tracking_not_healthy: 2, budget_locked_pending: 1, unspecified: 1 },
    by_action: { adjust_budget: 2, pause_keyword: 1, unknown: 1 },
  });
});

test('a runaway reason cannot bloat the job row', () => {
  const tally = emptyReasonTally();
  tallyReason(tally, { code: 'x'.repeat(500), action_type: 'y'.repeat(500) });
  assert.equal(Object.keys(tally.by_reason)[0].length, 64);
  assert.equal(Object.keys(tally.by_action)[0].length, 64);
});

test('the optimize job run keeps the tracking verdicts and the refusal counts in its details', () => {
  const route = readFileSync(new URL('../app/api/cron/optimize/route.ts', import.meta.url), 'utf8');
  // Counted per account right after the snapshot, from the same verdict the model and the gates see.
  assert.match(route, /tallyTrackingVerdict\(results\.tracking_verdicts, snapshot\.conversion_tracking\?\.status\)/);
  // Every guardrail refusal is tallied by its reason.
  assert.match(route, /onReject: \(rejection\) => tallyReason\(results\.gate_rejections, rejection\)/);
  // Everything lands in the existing job_runs.details JSON.
  const finish = route.slice(route.indexOf('await finishJobRun({'), route.indexOf('if (alertPlan?.send)'));
  for (const key of ['tracking_verdicts', 'gate_rejections', 'duplicates_skipped', 'dedupe_skips', 'recommendations_renewed']) {
    assert.match(finish, new RegExp(`${key}: results\\.${key}`), key);
  }
});

test('the cron skips duplicates after the guardrails and before the policy, and remembers what it queues', () => {
  const route = readFileSync(new URL('../app/api/cron/optimize/route.ts', import.meta.url), 'utf8');
  const guardAt = route.indexOf('checkGuardrails(action, account.id, supabase');
  const dedupeAt = route.indexOf('findPendingDuplicate(recommendationPool, action)');
  const policyAt = route.indexOf('evaluateAutopilotPolicy({');
  assert.ok(guardAt > 0 && dedupeAt > guardAt && policyAt > dedupeAt, 'guardrails, then the duplicate check, then the policy');
  assert.match(route, /loadActiveRecommendationPool\(supabase, account\.id\)/);
  assert.match(route, /renewStalePendingRecommendation\(supabase, existing\.id, fields\)/);
  assert.match(route, /noteQueued\(action, queued, 'autopilot_fail_closed'\)/);
});
