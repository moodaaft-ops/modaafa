import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DID_MIN_CONTROL_CONVERSIONS,
  DID_MIN_TREATED_CONVERSIONS,
  computeDifferenceInDifferences,
  computeObservedImpact,
  type MetricTotals,
} from '../lib/ai/impact';
import {
  SUPPRESSED_BY_OUTCOME,
  classifyOutcome,
  findNegativeRepeat,
  loadOutcomeRecords,
  suppressNegativeRepeats,
  toOutcomeRecord,
  whatWorkedBlock,
  type OutcomeRecord,
} from '../lib/loops/outcome-memory';
import { EMPTY_LOOPS_CONTEXT, applyLoopFilters } from '../lib/loops/filter';
import { loopsPromptAddendum } from '../lib/loops/prompt';
import { prepareOptimizerLoops } from '../lib/loops/snapshot';
import { seasonContext } from '../lib/loops/seasons';

const totals = (cost: number, conversions: number, clicks = 100, value = 0): MetricTotals => ({
  cost,
  clicks,
  conversions,
  conversion_value: value,
});

test('computeObservedImpact is unchanged when no baseline is passed', () => {
  const impact = computeObservedImpact(totals(100, 5), totals(120, 6)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(impact).sort(), ['after', 'before', 'delta', 'measured_at', 'window_days']);
  assert.equal((impact.delta as any).cost, 20);
});

test('with a baseline the result adds baseline and diff_in_diff, old fields stay', () => {
  const impact = computeObservedImpact(totals(100, 10), totals(120, 12), {
    before: totals(500, 40),
    after: totals(450, 36),
    campaigns: 3,
  }) as any;
  assert.equal(impact.delta.cost, 20);
  assert.equal(impact.baseline.campaigns, 3);
  assert.equal(impact.diff_in_diff.method, 'difference_in_differences');
});

test('difference in differences subtracts what happened to the untouched campaigns', () => {
  const did = computeDifferenceInDifferences(
    { before: totals(100, 20), after: totals(100, 14) },
    { before: totals(1000, 100), after: totals(1000, 70), campaigns: 4 }
  );
  assert.equal(did.treated_change_pct.conversions, -30);
  assert.equal(did.control_change_pct.conversions, -30);
  assert.equal(did.did_pct_points.conversions, 0); // the whole account dipped: not the change's fault
  const worse = computeDifferenceInDifferences(
    { before: totals(100, 20), after: totals(100, 10) },
    { before: totals(1000, 100), after: totals(1000, 100), campaigns: 4 }
  );
  assert.equal(worse.did_pct_points.conversions, -50);
  assert.equal(worse.did_pct_points.cost, 0);
});

test('small volume is labelled low, honestly', () => {
  const small = computeDifferenceInDifferences(
    { before: totals(100, 3), after: totals(100, 2) },
    { before: totals(1000, 100), after: totals(1000, 100), campaigns: 4 }
  );
  assert.equal(small.confidence, 'low');
  assert.match(small.confidence_reason_ar, /قليلة/);
  const noControl = computeDifferenceInDifferences({ before: totals(100, 30), after: totals(100, 30) }, null);
  assert.equal(noControl.confidence, 'low');
  assert.equal(noControl.did_pct_points.conversions, null);
  const thinControl = computeDifferenceInDifferences(
    { before: totals(100, 10), after: totals(100, 10) },
    { before: totals(100, 5), after: totals(100, 5), campaigns: 1 }
  );
  assert.equal(thinControl.confidence, 'low');
});

test('medium and high need the documented volumes', () => {
  assert.equal(DID_MIN_TREATED_CONVERSIONS, 15);
  assert.equal(DID_MIN_CONTROL_CONVERSIONS, 30);
  const medium = computeDifferenceInDifferences(
    { before: totals(100, 10), after: totals(100, 10) },
    { before: totals(500, 20), after: totals(500, 20), campaigns: 2 }
  );
  assert.equal(medium.confidence, 'medium');
  const high = computeDifferenceInDifferences(
    { before: totals(400, 40), after: totals(400, 40) },
    { before: totals(800, 60), after: totals(800, 60), campaigns: 5 }
  );
  assert.equal(high.confidence, 'high');
});

const budgetRow = (id: string, resource: string, deltaPct: number, impact: unknown, createdAt = '2026-10-01T00:00:00Z') => ({
  id,
  action_type: 'adjust_budget',
  created_at: createdAt,
  payload: { action: { type: 'adjust_budget', params: { budget_resource: resource, delta_pct: deltaPct } } },
  observed_impact: impact,
});

test('a budget raise that cost more and lost conversions measures negative', () => {
  const record = toOutcomeRecord(budgetRow('a1', 'customers/1/campaignBudgets/9', 20, { before: totals(100, 10), after: totals(140, 6) }));
  assert.equal(record.verdict, 'negative');
  assert.equal(record.direction, 'up');
  assert.equal(record.entity, 'customers/1/campaignBudgets/9');
});

test('thin data is unknown, never negative', () => {
  const record = toOutcomeRecord(budgetRow('a2', 'customers/1/campaignBudgets/9', 20, { before: totals(100, 1), after: totals(140, 0) }));
  assert.equal(record.verdict, 'unknown');
});

test('a drop the control group shared is not blamed on the change', () => {
  const impact = {
    before: totals(100, 10),
    after: totals(140, 6),
    diff_in_diff: { did_pct_points: { conversions: -2, cost: null, cost_per_conversion: null }, confidence: 'medium' },
  };
  assert.equal(classifyOutcome('adjust_budget', 'up', impact as any).verdict, 'neutral');
});

function record(over: Partial<OutcomeRecord>): OutcomeRecord {
  return {
    action_id: 'x',
    action_type: 'adjust_budget',
    direction: 'up',
    entity: 'customers/1/campaignBudgets/9',
    created_at: '2026-10-01T00:00:00Z',
    verdict: 'negative',
    confidence: 'medium',
    reason_ar: 'x',
    before: totals(100, 10),
    after: totals(140, 6),
    ...over,
  };
}

test('a repeat of a negative change on the same entity in the same direction is suppressed', () => {
  const raise = { type: 'adjust_budget', params: { budget_resource: 'customers/1/campaignBudgets/9', delta_pct: 15 } };
  const cut = { type: 'adjust_budget', params: { budget_resource: 'customers/1/campaignBudgets/9', delta_pct: -15 } };
  const other = { type: 'adjust_budget', params: { budget_resource: 'customers/1/campaignBudgets/77', delta_pct: 15 } };
  const records = [record({})];
  assert.ok(findNegativeRepeat(raise, records));
  assert.equal(findNegativeRepeat(cut, records), null); // direction matters
  assert.equal(findNegativeRepeat(other, records), null); // entity matters
  const { kept, suppressed } = suppressNegativeRepeats([raise, cut, other], records);
  assert.equal(suppressed.length, 1);
  assert.deepEqual(kept, [cut, other]);
  assert.equal(findNegativeRepeat(raise, [record({ verdict: 'positive' })]), null);
});

test('applyLoopFilters drops with a code and an Arabic reason, and is a no-op with an empty context', () => {
  const raise = { type: 'adjust_budget', params: { budget_resource: 'customers/1/campaignBudgets/9', delta_pct: 15 } };
  const pause = { type: 'pause_campaign', target_id: 'customers/1/campaigns/2' };
  const none = applyLoopFilters([raise, pause], EMPTY_LOOPS_CONTEXT);
  assert.deepEqual(none.kept, [raise, pause]);
  assert.equal(none.dropped.length, 0);

  const filtered = applyLoopFilters([raise, pause], {
    outcomes: [record({})],
    season: seasonContext('2026-03-01'),
    merchantFacts: null,
    today: '2026-03-01',
  });
  assert.deepEqual(filtered.dropped.map((d) => d.code).sort(), ['season_week', SUPPRESSED_BY_OUTCOME].sort());
  assert.equal(filtered.kept.length, 0);
  for (const d of filtered.dropped) {
    assert.ok(d.reason_ar.length > 10);
    assert.doesNotMatch(d.reason_ar, /[—–]/);
  }
});

test('the what-worked block carries evidence and is null when nothing was measured', () => {
  assert.equal(whatWorkedBlock([]), null);
  assert.equal(whatWorkedBlock([record({ verdict: 'neutral' })]), null);
  const block = whatWorkedBlock([record({}), record({ verdict: 'positive', action_id: 'p' })], new Date('2026-10-10T00:00:00Z'))!;
  assert.equal(block.worked.length, 1);
  assert.equal(block.did_not_work.length, 1);
  assert.equal(block.did_not_work[0].days_ago, 9);
});

test('loadOutcomeRecords never throws and reads only the last 90 days of measured actions', async () => {
  const calls: Array<[string, unknown]> = [];
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    gte: (col: string, value: unknown) => (calls.push([col, value]), chain),
    not: () => chain,
    order: () => chain,
    limit: async () => ({ data: [budgetRow('a1', 'customers/1/campaignBudgets/9', 20, { before: totals(100, 10), after: totals(140, 6) })], error: null }),
  };
  const records = await loadOutcomeRecords({ from: () => chain }, 'acc', new Date('2026-10-19T00:00:00Z'));
  assert.equal(records.length, 1);
  assert.equal(calls[0][0], 'created_at');
  assert.equal(String(calls[0][1]).slice(0, 10), '2026-07-21');
  const broken = await loadOutcomeRecords({ from: () => { throw new Error('boom'); } }, 'acc');
  assert.deepEqual(broken, []);
});

test('flag off: no I/O, no prompt words, nothing dropped', async () => {
  let touched = false;
  const trap = new Proxy({}, { get: () => { touched = true; throw new Error('should not be touched'); } });
  const snapshot: any = { economics: { allowable_cpa_cut: { value: 50, source: 'x' } } };
  const context = await prepareOptimizerLoops({
    snapshot,
    customer: trap as any,
    supabase: trap,
    accountId: 'a',
    businessId: 'b',
    env: {},
  });
  assert.equal(context, EMPTY_LOOPS_CONTEXT);
  assert.equal(touched, false);
  assert.deepEqual(Object.keys(snapshot), ['economics']);
  assert.equal(loopsPromptAddendum(snapshot), '');
});

test('flag on adds only the block of the switch that is on', async () => {
  const snapshot: any = { economics: null };
  const context = await prepareOptimizerLoops({
    snapshot,
    customer: { query: async () => [] },
    supabase: {},
    accountId: 'a',
    businessId: 'b',
    now: new Date('2026-03-01T09:00:00Z'),
    env: { SEASONS_ENABLED: 'true' },
  });
  assert.ok(context.season?.judgement_unreliable);
  assert.ok(snapshot.season_context);
  assert.equal(snapshot.ngram_analysis, undefined);
  assert.match(loopsPromptAddendum(snapshot), /season_context/);
  assert.doesNotMatch(loopsPromptAddendum(snapshot), /ngram_analysis/);
});
