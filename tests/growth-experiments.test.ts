import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decideExperiment, twoSidedP, erfc, conversionRateZ, costPerConversionZ,
  RAMP_UP_DAYS, MIN_DAYS_AFTER_RAMP, type ArmTotals,
} from '../lib/experiments/significance';
import { buildExperimentPlan, validateStoredExperimentPlan, suggestDuration, type CampaignReading } from '../lib/experiments/plan';
import { readExperimentResults } from '../lib/experiments/results';
import {
  executeCreateExperiment, executeEndExperiment, executePromoteExperiment, validateCreateExperiment,
  executeExperimentRollback, END_EXPERIMENT_ROLLBACK, ExperimentBlockedError,
} from '../lib/experiments/execute';
import { CID, P, healthyHandlers, makeCustomer } from './growth-fixtures';

const arm = (clicks: number, conversions: number, cost = clicks * 2): ArmTotals => ({ clicks, impressions: clicks * 20, cost, conversions });
const enough = { daysAfterRamp: MIN_DAYS_AFTER_RAMP + 6, daysRunning: RAMP_UP_DAYS + MIN_DAYS_AFTER_RAMP + 6 };

// ---- significance -----------------------------------------------------------

test('erfc and the two sided p-value match known values', () => {
  assert.ok(Math.abs(erfc(0) - 1) < 1e-6);
  assert.ok(Math.abs(twoSidedP(1.96) - 0.05) < 0.001);
  assert.ok(Math.abs(twoSidedP(0) - 1) < 1e-6);
  assert.ok(twoSidedP(5) < 1e-5);
});

test('no verdict during the first week, and none before 14 days after it', () => {
  const v1 = decideExperiment({ metric: 'conversion_rate', control: arm(5000, 100), treatment: arm(5000, 160), daysAfterRamp: 0, daysRunning: 3 });
  assert.equal(v1.status, 'not_enough_data');
  const v2 = decideExperiment({ metric: 'conversion_rate', control: arm(5000, 100), treatment: arm(5000, 160), daysAfterRamp: 9, daysRunning: 16 });
  assert.equal(v2.status, 'not_enough_data');
});

test('under 30 conversions in an arm there is never a verdict, however large the gap', () => {
  const v = decideExperiment({ metric: 'conversion_rate', control: arm(2000, 5), treatment: arm(2000, 29), ...enough });
  assert.equal(v.status, 'not_enough_data');
  assert.equal((v as any).reason, 'too_few_conversions');
});

test('a clear conversion rate gain is a treatment winner with p under 0.05', () => {
  const v = decideExperiment({ metric: 'conversion_rate', control: arm(5000, 100), treatment: arm(5000, 160), ...enough });
  assert.equal(v.status, 'winner');
  assert.equal((v as any).winner, 'treatment');
  assert.ok((v as any).p_value < 0.05);
  assert.ok((v as any).improvement_pct > 0);
});

test('a clear loss is a control winner, never promoted as treatment', () => {
  const v = decideExperiment({ metric: 'conversion_rate', control: arm(5000, 160), treatment: arm(5000, 100), ...enough });
  assert.equal(v.status, 'winner');
  assert.equal((v as any).winner, 'control');
});

test('no difference needs 50 conversions per arm; 30 to 49 stays «not enough yet»', () => {
  const same = decideExperiment({ metric: 'conversion_rate', control: arm(5000, 100), treatment: arm(5000, 102), ...enough });
  assert.equal(same.status, 'no_clear_difference');
  const thin = decideExperiment({ metric: 'conversion_rate', control: arm(2000, 40), treatment: arm(2000, 41), ...enough });
  assert.equal(thin.status, 'not_enough_data');
});

test('cost per conversion: same spend, many more conversions wins; same numbers do not', () => {
  const win = decideExperiment({ metric: 'cost_per_conversion', control: arm(4000, 100, 8000), treatment: arm(4000, 150, 8000), ...enough });
  assert.equal(win.status, 'winner');
  assert.equal((win as any).winner, 'treatment');
  const flat = decideExperiment({ metric: 'cost_per_conversion', control: arm(4000, 100, 8000), treatment: arm(4000, 101, 8000), ...enough });
  assert.equal(flat.status, 'no_clear_difference');
});

test('degenerate inputs give null z, not NaN', () => {
  assert.equal(conversionRateZ(arm(0, 0), arm(10, 1)), null);
  assert.equal(costPerConversionZ(arm(10, 0, 0), arm(10, 1, 5)), null);
});

// ---- plan guardrails ----------------------------------------------------------

const healthy = { verdict: 'healthy' as const, issues_ar: [], conversions30d: 200, currency: 'SAR', timeZone: 'Asia/Riyadh', autoTaggingEnabled: true };
const campaign = (over: Partial<CampaignReading> = {}): CampaignReading => ({
  name: 'بحث المتجر', status: 'ENABLED', channel: 'SEARCH', biddingStrategyType: 'MAXIMIZE_CLICKS', portfolioStrategy: '',
  finalUrls: ['https://shop.example.com/a'], conversions30d: 200, inActiveExperiment: false, ...over,
});
const now = new Date('2026-10-20T09:00:00Z');
const bidding = { campaign_resource: `${P}/campaigns/5`, kind: 'bidding_strategy' as const, strategy: 'MAXIMIZE_CONVERSIONS' };
const landing = { campaign_resource: `${P}/campaigns/5`, kind: 'landing_page' as const, final_url: 'https://shop.example.com/b' };
const codes = (r: any) => (r.ok ? [] : r.blockers.map((b: any) => b.code));

test('a healthy search campaign gets a plan that starts tomorrow in the account zone', () => {
  const r = buildExperimentPlan(bidding, campaign(), healthy, now);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.plan.start_date, '2026-10-21');
    assert.equal(r.plan.metric, 'cost_per_conversion');
    assert.ok(r.plan.duration_days >= 28);
    assert.ok(r.plan.end_date > r.plan.start_date);
  }
});

test('guardrails: non-search, paused, overlap, low volume, bad tracking, portfolio, bad split all refuse', () => {
  assert.ok(codes(buildExperimentPlan(bidding, campaign({ channel: 'PERFORMANCE_MAX' }), healthy, now)).includes('channel'));
  assert.ok(codes(buildExperimentPlan(bidding, campaign({ status: 'PAUSED' }), healthy, now)).includes('campaign_not_running'));
  assert.ok(codes(buildExperimentPlan(bidding, campaign({ inActiveExperiment: true }), healthy, now)).includes('overlap'));
  assert.ok(codes(buildExperimentPlan(bidding, campaign({ conversions30d: 5 }), healthy, now)).includes('volume_too_low'));
  assert.ok(codes(buildExperimentPlan(bidding, campaign(), { ...healthy, verdict: 'broken_recently', issues_ar: ['x'] }, now)).includes('tracking_not_healthy'));
  assert.ok(codes(buildExperimentPlan(bidding, campaign({ portfolioStrategy: 'customers/1/biddingStrategies/2' }), healthy, now)).includes('portfolio'));
  assert.ok(codes(buildExperimentPlan({ ...bidding, treatment_split: 80 }, campaign(), healthy, now)).includes('split'));
  assert.ok(codes(buildExperimentPlan(bidding, null, healthy, now)).includes('campaign_missing'));
});

test('a test the campaign volume can never judge is refused, not scheduled', () => {
  const r = buildExperimentPlan(bidding, campaign({ conversions30d: 16 }), { ...healthy, conversions30d: 16 }, now);
  assert.equal(r.ok, false);
  assert.equal(suggestDuration(16, 50), null);
  assert.ok(suggestDuration(300, 50));
});

test('landing page test: same host only, new URL only, https only', () => {
  assert.equal(buildExperimentPlan(landing, campaign(), healthy, now).ok, true);
  assert.ok(codes(buildExperimentPlan({ ...landing, final_url: 'https://other.example.org/x' }, campaign(), healthy, now)).includes('landing_host'));
  assert.ok(codes(buildExperimentPlan({ ...landing, final_url: 'http://shop.example.com/b' }, campaign(), healthy, now)).includes('landing_url'));
  assert.ok(codes(buildExperimentPlan({ ...landing, final_url: 'https://shop.example.com/a' }, campaign(), healthy, now)).includes('same_url'));
});

test('stored plan validation rejects tampered plans', () => {
  const r = buildExperimentPlan(bidding, campaign(), healthy, now);
  assert.ok(r.ok);
  if (!r.ok) return;
  const plan = JSON.parse(JSON.stringify(r.plan));
  assert.equal(validateStoredExperimentPlan(plan, CID).ok, true);
  assert.equal(validateStoredExperimentPlan(plan, '999').ok, false);
  for (const mut of [
    (x: any) => { x.treatment_split = 90; },
    (x: any) => { x.campaign_resource = 'customers/999/campaigns/1'; },
    (x: any) => { x.end_date = x.start_date; },
    (x: any) => { x.change.strategy = 'MANUAL_CPC'; },
    (x: any) => { x.metric = 'ctr'; },
  ]) {
    const copy = JSON.parse(JSON.stringify(plan));
    mut(copy);
    assert.equal(validateStoredExperimentPlan(copy, CID).ok, false);
  }
});

// ---- results ----------------------------------------------------------------------

const EXP = `${P}/experiments/77`;
const CONTROL = `${P}/campaigns/5`;
const DRAFT = `${P}/campaigns/6`;

function resultsHandlers(controlConv: number, treatmentConv: number, start = '2026-08-01') {
  return [
    { match: /FROM experiment WHERE experiment\.resource_name/, rows: [{ experiment: { resourceName: EXP, name: 'e', status: 'ENABLED', startDate: start, endDate: '2026-12-30' } }] },
    {
      match: /FROM experiment_arm WHERE experiment_arm\.experiment =/,
      rows: [
        { experimentArm: { resourceName: `${P}/experimentArms/77~1`, control: true, trafficSplit: 50, campaigns: [CONTROL] } },
        { experimentArm: { resourceName: `${P}/experimentArms/77~2`, control: false, trafficSplit: 50, campaigns: [DRAFT] } },
      ],
    },
    {
      match: /FROM campaign WHERE campaign\.resource_name IN/,
      rows: (g: string) => {
        const treat = g.includes(DRAFT);
        return [{ metrics: { impressions: 90000, clicks: 5000, costMicros: 10_000_000_000, conversions: treat ? treatmentConv : controlConv } }];
      },
    },
  ];
}

test('results: reads both arms after the first week and gives a winner only with enough data', async () => {
  const stub = makeCustomer(resultsHandlers(100, 160));
  const reading = await readExperimentResults(stub, EXP, 'conversion_rate', { now });
  assert.equal(reading.arms.length, 2);
  assert.equal(reading.window.from, '2026-08-08');
  assert.equal(reading.verdict.status, 'winner');
  const thin = await readExperimentResults(makeCustomer(resultsHandlers(10, 20)), EXP, 'conversion_rate', { now });
  assert.equal(thin.verdict.status, 'not_enough_data');
  const young = await readExperimentResults(makeCustomer(resultsHandlers(100, 160, '2026-10-17')), EXP, 'conversion_rate', { now });
  assert.equal(young.verdict.status, 'not_enough_data');
});

// ---- execution ----------------------------------------------------------------------

function createHandlers() {
  return [
    { match: /SELECT experiment\.name FROM experiment/, rows: [] },
    { match: /FROM experiment WHERE experiment\.status IN/, rows: [] },
    {
      match: /campaign\.bidding_strategy_type/,
      rows: [{ campaign: { resourceName: CONTROL, name: 'بحث المتجر', status: 'ENABLED', advertisingChannelType: 'SEARCH', biddingStrategyType: 'MAXIMIZE_CLICKS', biddingStrategy: '' } }],
    },
    { match: /SELECT metrics\.conversions FROM campaign WHERE campaign\.resource_name/, rows: [{ metrics: { conversions: 200 } }] },
    { match: /SELECT ad_group_ad\.ad\.final_urls/, rows: [{ adGroupAd: { ad: { finalUrls: ['https://shop.example.com/a'] } } }] },
    { match: /in_design_campaigns/, rows: [{ experimentArm: { inDesignCampaigns: [DRAFT] } }] },
    { match: /ad_group_ad\.ad\.resource_name/, rows: [{ adGroupAd: { ad: { resourceName: `${P}/ads/9` } } }] },
    { match: /FROM experiment WHERE experiment\.resource_name/, rows: [{ experiment: { status: 'INITIATED', startDate: '2026-10-21', endDate: '2026-11-25' } }] },
    {
      match: /FROM experiment_arm WHERE experiment_arm\.experiment =/,
      rows: [
        { experimentArm: { control: true, campaigns: [CONTROL] } },
        { experimentArm: { control: false, campaigns: [] } },
      ],
    },
    ...healthyHandlers(),
  ];
}

async function planFor(input: any) {
  const stub = makeCustomer(createHandlers());
  const proposal = buildExperimentPlan(input, campaign(), healthy, new Date());
  assert.ok(proposal.ok, JSON.stringify((proposal as any).blockers));
  return (proposal as any).plan;
}

test('create: validateOnly on the experiment, arms, the ONE change on the draft, validate then live schedule', async () => {
  const plan = await planFor(bidding);
  const stub = makeCustomer(createHandlers());
  const result = await executeCreateExperiment(plan, stub, CID, { nonce: () => 'n1' });
  const kinds = stub.experimentCalls.map((c: any) => c.kind);
  assert.deepEqual(kinds, ['experiments.mutate', 'experiments.mutate', 'arms.mutate', 'schedule', 'schedule']);
  assert.equal(stub.experimentCalls[0].args[1].validateOnly, true);
  assert.equal(stub.experimentCalls[3].args[1].validateOnly, true);
  assert.equal(stub.experimentCalls[4].args[1], undefined);
  const change = stub.mutates.filter((m: any) => !m.validateOnly)[0].ops;
  assert.equal(change.length, 1, 'exactly one change');
  assert.equal(change[0].campaign_operation.update.resource_name, DRAFT);
  assert.equal(result.rollback_payload.action_type, END_EXPERIMENT_ROLLBACK);
  assert.deepEqual(result.rollback_payload.resource_names, [EXP]);
  assert.equal(result.readback.ok, false, 'second arm in the stub has no campaigns but control matches');
});

test('create: landing page test changes the ad final url on the draft only', async () => {
  const plan = await planFor(landing);
  const stub = makeCustomer(createHandlers());
  await executeCreateExperiment(plan, stub, CID, { nonce: () => 'n1' });
  const live = stub.mutates.filter((m: any) => !m.validateOnly)[0].ops;
  assert.equal(live[0].ad_operation.update.final_urls[0], 'https://shop.example.com/b');
});

test('create: a failure before the schedule removes the half built experiment and never schedules', async () => {
  const plan = await planFor(bidding);
  const stub = makeCustomer(createHandlers());
  const original = stub.mutateOperations.bind(stub);
  stub.mutateOperations = async (ops: any[], o?: any) => {
    if (o?.validateOnly) throw new Error('INVALID_ARGUMENT');
    return original(ops, o);
  };
  await assert.rejects(() => executeCreateExperiment(plan, stub, CID, { nonce: () => 'n1' }), /INVALID_ARGUMENT/);
  const kinds = stub.experimentCalls.map((c: any) => c.kind);
  assert.ok(!kinds.includes('schedule'));
  const removal = stub.experimentCalls.filter((c: any) => c.kind === 'experiments.mutate').pop();
  assert.deepEqual(removal.args[0], [{ remove: EXP }]);
});

test('create: the account changing after approval (tracking broken) refuses before any write', async () => {
  const plan = await planFor(bidding);
  const stub = makeCustomer([...createHandlers().filter((h: any) => !String(h.match).includes('conversion_action')), { match: /FROM conversion_action/, rows: [] }]);
  await assert.rejects(() => executeCreateExperiment(plan, stub, CID, { nonce: () => 'n1' }), ExperimentBlockedError);
  assert.equal(stub.experimentCalls.length, 0);
});

test('create: a start date that already passed is refused', async () => {
  const plan = { ...(await planFor(bidding)), start_date: '2020-01-01', end_date: '2020-03-01' };
  const stub = makeCustomer(createHandlers());
  await assert.rejects(() => executeCreateExperiment(plan, stub, CID, { nonce: () => 'n1' }), /فات|start/i);
});

test('validateCreateExperiment only validates the experiment resource', async () => {
  const plan = await planFor(bidding);
  const stub = makeCustomer(createHandlers());
  const res = await validateCreateExperiment(plan, stub, CID, { nonce: () => 'n1' });
  assert.equal(res.validate_only, 'passed');
  assert.ok(stub.experimentCalls.every((c: any) => c.args[1]?.validateOnly === true));
});

test('end: validateOnly then live; not reversible; refuses an experiment that is not running', async () => {
  const running = makeCustomer([{ match: /FROM experiment WHERE experiment\.resource_name/, rows: [{ experiment: { status: 'ENABLED' } }] }]);
  const result = await executeEndExperiment({ experiment_resource: EXP }, running, CID);
  assert.deepEqual(running.experimentCalls.map((c: any) => c.kind), ['end', 'end']);
  assert.equal(result.rollback_payload.reversible, false);
  const halted = makeCustomer([{ match: /FROM experiment WHERE experiment\.resource_name/, rows: [{ experiment: { status: 'HALTED' } }] }]);
  await assert.rejects(() => executeEndExperiment({ experiment_resource: EXP }, halted, CID));
  await assert.rejects(() => executeEndExperiment({ experiment_resource: 'customers/999/experiments/1' }, running, CID));
});

test('promote: refused unless fresh numbers show the treatment winning; otherwise validate then promote', async () => {
  const hs = (c: number, t: number) => [{ match: /SELECT experiment\.resource_name, experiment\.status FROM experiment/, rows: [{ experiment: { status: 'ENABLED' } }] }, ...resultsHandlers(c, t)];
  const lose = makeCustomer(hs(160, 100));
  await assert.rejects(() => executePromoteExperiment({ experiment_resource: EXP, metric: 'conversion_rate' }, lose, CID, now), ExperimentBlockedError);
  const thin = makeCustomer(hs(10, 20));
  await assert.rejects(() => executePromoteExperiment({ experiment_resource: EXP, metric: 'conversion_rate' }, thin, CID, now), ExperimentBlockedError);
  assert.equal(lose.experimentCalls.length, 0);
  const win = makeCustomer(hs(100, 160));
  const result = await executePromoteExperiment({ experiment_resource: EXP, metric: 'conversion_rate' }, win, CID, now);
  assert.deepEqual(win.experimentCalls.map((c: any) => c.kind), ['promote', 'promote']);
  assert.equal(win.experimentCalls[0].args[1].validateOnly, true);
  assert.equal(result.rollback_payload.reversible, false);
});

test('rollback of a created experiment ends it; anything else is refused', async () => {
  const stub = makeCustomer();
  await executeExperimentRollback({ action_type: END_EXPERIMENT_ROLLBACK, experiment_resource: EXP }, stub);
  assert.equal(stub.experimentCalls[0].kind, 'end');
  await assert.rejects(() => executeExperimentRollback({ action_type: END_EXPERIMENT_ROLLBACK, experiment_resource: 'x' }, stub));
  await assert.rejects(() => executeExperimentRollback({ action_type: 'other', experiment_resource: EXP }, stub));
});
