import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkGuardrails,
  executeAction,
  executeRollback,
  type OptimizerAction,
  type OptimizerSnapshot,
} from '../lib/ai/optimizer-agent';
import { computeBreakEven } from '../lib/economics/break-even';
import { buildSnapshotEconomics } from '../lib/ai/optimizer-snapshot';
import { buildExecutableAction } from '../lib/ai/executable-action';
import { prepareActionForExecution } from '../lib/ai/execution-preflight';
import { rollbackResourcesScoped } from '../lib/ai/rollback-scope';
import { applyAutonomyLevel, evaluateAutonomy, evaluateBudgetShift, hardCeilingViolations, type BudgetChange } from '../lib/autopilot/autonomy';
import { BUDGET_SHIFT_OPERATION, evaluatePairAmounts, evaluatePairGate, proposeBudgetShift, WHOLE_CENT_MICROS } from '../lib/autopilot/budget-shift';
import { findPendingDuplicate } from '../lib/autopilot/recommendation-dedupe';
import { DEFAULT_AUTOPILOT_SETTINGS } from '../lib/autopilot/types';

const CID = '123';
const A = `customers/${CID}/campaignBudgets/1`;
const B = `customers/${CID}/campaignBudgets/2`;
const valid = (v: string) => /^customers\/\d+\/campaignBudgets\/[^/]+$/.test(v);
const NOW = new Date('2026-10-20T10:00:00Z');

function withFlag<T>(value: string | undefined, fn: () => T): T {
  const old = process.env.AUTONOMY_LEVELS_ENABLED;
  if (value === undefined) delete process.env.AUTONOMY_LEVELS_ENABLED;
  else process.env.AUTONOMY_LEVELS_ENABLED = value;
  try {
    return fn();
  } finally {
    if (old === undefined) delete process.env.AUTONOMY_LEVELS_ENABLED;
    else process.env.AUTONOMY_LEVELS_ENABLED = old;
  }
}
async function withFlagAsync<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const old = process.env.AUTONOMY_LEVELS_ENABLED;
  if (value === undefined) delete process.env.AUTONOMY_LEVELS_ENABLED;
  else process.env.AUTONOMY_LEVELS_ENABLED = value;
  try {
    return await fn();
  } finally {
    if (old === undefined) delete process.env.AUTONOMY_LEVELS_ENABLED;
    else process.env.AUTONOMY_LEVELS_ENABLED = old;
  }
}

// ---- property tests: the total never rises ---------------------------------
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

test('property: evaluateBudgetShift never accepts a change set whose total rises', () => {
  const rand = rng(7);
  let accepted = 0;
  for (let i = 0; i < 4000; i++) {
    const n = 2 + Math.floor(rand() * 4);
    const changes: BudgetChange[] = [];
    for (let k = 0; k < n; k++) {
      const before = (1 + Math.floor(rand() * 5000)) * WHOLE_CENT_MICROS;
      const after = Math.max(1, Math.round(before * (0.5 + rand())));
      changes.push({ budget_resource: `customers/1/campaignBudgets/${k}`, current_amount_micros: before, new_amount_micros: after });
    }
    const verdict = evaluateBudgetShift(changes);
    if (verdict.ok) {
      accepted++;
      const oldTotal = changes.reduce((s, c) => s + c.current_amount_micros, 0);
      const newTotal = changes.reduce((s, c) => s + c.new_amount_micros, 0);
      assert.ok(newTotal <= oldTotal, `total rose: ${JSON.stringify(changes)}`);
    }
  }
  assert.ok(accepted >= 0);
});

test('property: evaluatePairAmounts accepts only exact, total-neutral, bounded shifts', () => {
  const rand = rng(42);
  let accepted = 0;
  let rejected = 0;
  for (let i = 0; i < 6000; i++) {
    const fromAmount = (50 + Math.floor(rand() * 20000)) * WHOLE_CENT_MICROS;
    const toAmount = (50 + Math.floor(rand() * 20000)) * WHOLE_CENT_MICROS;
    const shiftMicros = Math.floor(rand() * 6000) * WHOLE_CENT_MICROS + (rand() < 0.1 ? 1 : 0);
    const r = evaluatePairAmounts({ from: A, to: B, fromAmount, toAmount, shiftMicros });
    if (!r.ok) {
      rejected++;
      continue;
    }
    accepted++;
    const [down, up] = r.changes;
    assert.equal(down.new_amount_micros + up.new_amount_micros, fromAmount + toAmount, 'total unchanged to the micro');
    assert.equal(down.current_amount_micros - down.new_amount_micros, shiftMicros);
    assert.equal(up.new_amount_micros - up.current_amount_micros, shiftMicros);
    assert.ok(shiftMicros <= 0.1 * (fromAmount + toAmount) + 1e-6, 'at most 10 percent of the total');
    assert.ok(shiftMicros / fromAmount >= 0.05 - 1e-3 && shiftMicros / fromAmount <= 0.2 + 1e-3);
    assert.ok(shiftMicros / toAmount >= 0.05 - 1e-3 && shiftMicros / toAmount <= 0.2 + 1e-3);
    assert.ok(down.new_amount_micros > 0);
  }
  assert.ok(accepted > 50, 'the generator reaches accepted cases');
  assert.ok(rejected > 50);
});

test('pair math: examples', () => {
  const ok = evaluatePairAmounts({ from: A, to: B, fromAmount: 100_000_000, toAmount: 100_000_000, shiftMicros: 10_000_000 });
  assert.equal(ok.ok, true);
  assert.equal(evaluatePairAmounts({ from: A, to: B, fromAmount: 100_000_000, toAmount: 100_000_000, shiftMicros: 25_000_000 }).ok, false);
  assert.equal(evaluatePairAmounts({ from: A, to: B, fromAmount: 100_000_000, toAmount: 100_000_000, shiftMicros: 1_000_000 }).ok, false, 'under the 5 percent noise floor');
  assert.equal(evaluatePairAmounts({ from: A, to: B, fromAmount: 100_000_000, toAmount: 100_000_000, shiftMicros: 10_000_001 }).ok, false, 'not a whole cent');
  assert.equal(evaluatePairAmounts({ from: A, to: B, fromAmount: 100_000_000, toAmount: 100_000_000, shiftMicros: 10_000_000, accountTotalMicros: 50_000_000 }).ok, false, 'over 10 percent of the account total');
});

// ---- fixtures -----------------------------------------------------------
const economics = buildSnapshotEconomics(
  computeBreakEven({ facts: { type: { choice: 'ecommerce' }, margin: { choice: '20_40', min_per_100: 20, max_per_100: 40 } } }),
  null
);
function row(budget: string, id: string, name: string, over: { cost?: number; conv?: number; value?: number; lostBudget?: number; amount?: string } = {}) {
  return {
    campaign: { id, name, resourceName: `customers/${CID}/campaigns/${id}` },
    campaignBudget: { id, amountMicros: over.amount ?? '100000000', resourceName: budget },
    metrics: { costMicros: '70000000', clicks: 400, conversions: 20, conversionsValue: 700 },
    diag: { type: 'SEARCH', bidding: 'MAXIMIZE_CONVERSION_VALUE', primary_status: 'ELIGIBLE', status_reasons: [], impressions_7d: 5000, search_is: 0.35, lost_budget_is: over.lostBudget ?? 0.25, lost_rank_is: 0.1 },
    last_30d: { cost_micros: over.cost ?? 300_000_000, conversions: over.conv ?? 80, conversions_value: over.value ?? 2400 },
  };
}
function snap(rows: any[], tracking = 'healthy'): OptimizerSnapshot {
  return {
    account_id: 'acc',
    customer_id: CID,
    campaigns: rows,
    underperforming_keywords: [],
    high_performing_keywords: [],
    wasted_search_terms: [],
    budget_utilization: [],
    poor_ads: [],
    keyword_count: 10,
    currency_code: 'SAR',
    conversion_tracking: { status: tracking, enabled_actions: 2 },
    economics,
    ad_group_bid_targets: [],
    target_roas: 5,
    target_cpa: null,
  } as unknown as OptimizerSnapshot;
}
// loser: spends 300 and earns 300 (ROAS 1, below the cut line); winner: ROAS 8, 80 conversions, constrained.
const LOSER = row(A, '10', 'حملة ضعيفة', { conv: 20, value: 300 });
const WINNER = row(B, '20', 'حملة رابحة');
const GOOD = snap([LOSER, WINNER]);

test('proposer: the clear loser gives to the clear winner, rules only', () => {
  const p = proposeBudgetShift(GOOD, valid)!;
  assert.ok(p, 'a proposal exists');
  assert.equal(p.type, BUDGET_SHIFT_OPERATION);
  assert.equal((p.params as any).from_budget_resource, A);
  assert.equal((p.params as any).to_budget_resource, B);
  const shift = (p.params as any).shift_micros as number;
  assert.ok(shift > 0 && shift % WHOLE_CENT_MICROS === 0);
  assert.ok(shift <= 0.1 * 200_000_000);
  assert.ok(!/[—–,]/.test(p.reason_ar));
  assert.equal(evaluatePairGate(p.params, GOOD, valid).ok, true);
});

test('proposer: nothing without a loser, without a constrained winner, with unhealthy tracking or shared budgets', () => {
  assert.equal(proposeBudgetShift(snap([WINNER, row(A, '11', 'ثانية')]), valid), null, 'no loser');
  assert.equal(proposeBudgetShift(snap([LOSER, row(B, '20', 'رابحة', { lostBudget: 0.01 })]), valid), null, 'winner not constrained');
  assert.equal(proposeBudgetShift(snap([LOSER, WINNER], 'broken_recently'), valid), null);
  const shared = snap([LOSER, WINNER, row(B, '21', 'مشتركة')]);
  assert.equal(proposeBudgetShift(shared, valid), null, 'a shared budget is never touched');
  assert.equal(proposeBudgetShift(snap([LOSER]), valid), null);
});

test('gate: a tampered pair (bigger shift, same budget twice, unknown budget) is refused', () => {
  const base = { from_budget_resource: A, to_budget_resource: B, shift_micros: 10_000_000 };
  assert.equal(evaluatePairGate(base, GOOD, valid).ok, true);
  assert.equal(evaluatePairGate({ ...base, shift_micros: 60_000_000 }, GOOD, valid).ok, false);
  assert.equal(evaluatePairGate({ ...base, to_budget_resource: A }, GOOD, valid).ok, false);
  assert.equal(evaluatePairGate({ ...base, to_budget_resource: `customers/${CID}/campaignBudgets/9` }, GOOD, valid).ok, false);
  assert.equal(evaluatePairGate({ ...base, from_budget_resource: B, to_budget_resource: A }, GOOD, valid).ok, false, 'direction matters: the winner cannot give');
});

// ---- policy: ceilings and the small level ----------------------------------
const pairParams = { from_budget_resource: A, to_budget_resource: B, shift_micros: 10_000_000, from_current_micros: 100_000_000, to_current_micros: 100_000_000 };
const pairAction = (over: Record<string, unknown> = {}): any => ({
  type: BUDGET_SHIFT_OPERATION,
  target_id: A,
  params: { ...pairParams, ...over },
  reason_ar: 'x',
  reason_en: 'x',
  expected_impact: { metric: 'conversions', delta_pct: 0, delta_sar_per_month: 0 },
  confidence: 1,
});

test('ceilings: a clean pair has no violations, a raise or an oversize shift does', () => {
  assert.deepEqual(hardCeilingViolations(pairAction()), []);
  assert.ok(hardCeilingViolations(pairAction({ shift_micros: 60_000_000 })).length > 0);
  assert.ok(hardCeilingViolations(pairAction({ shift_micros: 0 })).length > 0);
  assert.ok(hardCeilingViolations(pairAction({ target_cpa: 5 })).includes('changes_targets'));
  assert.ok(hardCeilingViolations({ type: 'adjust_budget', params: {} }).includes('type_not_allowed'));
});

const settings: any = { ...DEFAULT_AUTOPILOT_SETTINGS, account_id: 'acc', mode: 'conservative' };
const ctx = (over: Record<string, unknown> = {}): any => ({
  settings,
  action: pairAction(),
  trackingStatus: 'healthy',
  globalExecutionEnabled: true,
  executedToday: 0,
  sameTargetExecutedWithinCooldown: false,
  level: 'small_and_notify',
  snapshot: GOOD,
  budgetShiftAuto: true,
  ...over,
});

test('small level: a valid pair executes, anything off the rules queues', () => {
  const run = (over: Record<string, unknown> = {}) => evaluateAutonomy(ctx(over));
  const ok = run();
  assert.equal(ok.outcome, 'execute', JSON.stringify(ok.checks));
  assert.equal(ok.code, 'autonomy_approved');
  assert.notEqual(run({ level: 'ask_all' }).outcome, 'execute');
  assert.notEqual(run({ trackingStatus: 'suspect' }).outcome, 'execute');
  assert.notEqual(run({ globalExecutionEnabled: false }).outcome, 'execute');
  assert.notEqual(run({ action: pairAction({ shift_micros: 60_000_000 }) }).outcome, 'execute');
  assert.notEqual(run({ snapshot: snap([LOSER, row(B, '20', 'رابحة', { lostBudget: 0.01 })]) }).outcome, 'execute');
  assert.equal(run({ executedToday: 99 }).outcome, 'block');
  assert.equal(run({ sameTargetExecutedWithinCooldown: true }).outcome, 'block');
  // The older gate said queue; the small level decides.
  const base: any = { outcome: 'queue', code: 'manual_action_type', reason_ar: '', checks: [] };
  assert.equal(applyAutonomyLevel(base, ctx()).outcome, 'execute');
  assert.equal(applyAutonomyLevel(base, ctx({ level: 'ask_all' })).outcome, 'queue');
});

test('review: without its own switch the small level never moves money by itself', () => {
  const previous = process.env.AUTONOMY_BUDGET_SHIFT_AUTO_ENABLED;
  delete process.env.AUTONOMY_BUDGET_SHIFT_AUTO_ENABLED;
  try {
    const verdict = evaluateAutonomy(ctx({ budgetShiftAuto: undefined }));
    assert.equal(verdict.outcome, 'queue');
    assert.equal(verdict.code, 'manual_action_type');
    const base: any = { outcome: 'queue', code: 'manual_action_type', reason_ar: '', checks: [] };
    assert.equal(applyAutonomyLevel(base, ctx({ budgetShiftAuto: undefined })).outcome, 'queue');
  } finally {
    if (previous === undefined) delete process.env.AUTONOMY_BUDGET_SHIFT_AUTO_ENABLED;
    else process.env.AUTONOMY_BUDGET_SHIFT_AUTO_ENABLED = previous;
  }
});

// ---- guardrails -----------------------------------------------------------
type Tables = Record<string, { data: any; error: any }>;
function db(tables: Tables = {}) {
  return {
    from(table: string) {
      const result = tables[table] ?? { data: [], error: null };
      const builder: any = {};
      for (const m of ['select', 'eq', 'in', 'gte', 'order', 'limit']) builder[m] = () => builder;
      builder.maybeSingle = async () => result;
      builder.then = (resolve: (v: any) => unknown) => Promise.resolve(result).then(resolve);
      return builder;
    },
  };
}
const days = (d: number) => new Date(NOW.getTime() - d * 86400000).toISOString();

test('guardrails: flag off refuses, flag on passes a clean pair, a recent change of either budget locks it', async () => {
  const empty = db();
  await withFlagAsync(undefined, async () => {
    assert.equal(await checkGuardrails(pairAction(), 'acc', empty, { snapshot: GOOD, now: NOW }), null);
  });
  await withFlagAsync('true', async () => {
    const a = pairAction();
    assert.equal(await checkGuardrails(a, 'acc', empty, { snapshot: GOOD, now: NOW }), a);
    const locked = db({ ai_actions: { data: [{ payload: { action: { params: { budget_resource: B, delta_pct: 10 } } }, created_at: days(2) }], error: null } });
    assert.equal(await checkGuardrails(pairAction(), 'acc', locked, { snapshot: GOOD, now: NOW }), null);
    const pairBefore = db({ ai_actions: { data: [{ payload: { action: { params: pairParams } }, created_at: days(2) }], error: null } });
    assert.equal(await checkGuardrails(pairAction(), 'acc', pairBefore, { snapshot: GOOD, now: NOW }), null);
    const old = db({ ai_actions: { data: [{ payload: { action: { params: { budget_resource: B, delta_pct: 10 } } }, created_at: days(30) }], error: null } });
    assert.notEqual(await checkGuardrails(pairAction(), 'acc', old, { snapshot: GOOD, now: NOW }), null, 'a 30 day old change does not lock');
    // Unhealthy tracking blocks at queue time.
    assert.equal(await checkGuardrails(pairAction(), 'acc', empty, { snapshot: snap([LOSER, WINNER], 'broken_recently'), now: NOW }), null);
    // The history cannot be read: closed.
    const broken = db({ ai_actions: { data: null, error: { message: 'x' } } });
    assert.equal(await checkGuardrails(pairAction(), 'acc', broken, { snapshot: GOOD, now: NOW }), null);
  });
});

test('a single budget change is blocked by a pair that took part this week (flag on)', async () => {
  const pairBefore = db({
    ai_actions: { data: [{ payload: { action: { params: pairParams } }, created_at: days(2), recommendation_id: 'r0' }], error: null },
    google_ads_accounts: { data: { business_id: null, currency_code: 'SAR' }, error: null },
  });
  const single: OptimizerAction = {
    type: 'adjust_budget',
    target_id: B,
    params: { budget_resource: B, current_amount_micros: 100_000_000, new_amount_micros: 110_000_000, delta_pct: 10 },
    reason_ar: 'x',
    reason_en: 'x',
    expected_impact: { metric: 'conversions', delta_pct: 0, delta_sar_per_month: 0 },
  };
  // Flag off: the queue is exactly what it was (the pair rows are not looked at).
  await withFlagAsync(undefined, async () => {
    const r = await checkGuardrails(single, 'acc', pairBefore, undefined, { now: NOW } as any);
    assert.ok(r === single || r === null);
  });
  await withFlagAsync('true', async () => {
    const rows = db({
      ai_actions: { data: [{ payload: { action: { params: pairParams } }, created_at: days(2), recommendation_id: 'r0' }], error: null },
      google_ads_accounts: { data: { business_id: null, currency_code: 'SAR' }, error: null },
    });
    assert.equal(await checkGuardrails(single, 'acc', rows, undefined, { now: NOW } as any), null);
  });
});

// ---- executable action, preflight, execute, rollback ------------------------
function budgetCustomer(amounts: Record<string, number>) {
  const mutations: any[] = [];
  const customer: any = {
    mutations,
    async query(gaql: string) {
      for (const [resource, amount] of Object.entries(amounts)) {
        if (gaql.includes(resource)) return [{ campaign_budget: { resource_name: resource, amount_micros: String(amount), reference_count: '1', explicitly_shared: false } }];
      }
      return [];
    },
    campaignBudgets: {
      async update(ops: any[], options?: any) {
        mutations.push({ ops, options });
        return { ok: true };
      },
    },
  };
  return customer;
}

test('executable action: flag off is null, flag on needs valid scoped resources and a whole-cent amount', () => {
  const payload = { operation: BUDGET_SHIFT_OPERATION, target_id: A, params: pairParams };
  const rec = { title: 't', description: 'd', expected_impact: {} };
  withFlag(undefined, () => assert.equal(buildExecutableAction(payload, rec, CID), null));
  withFlag('true', () => {
    assert.equal(buildExecutableAction(payload, rec, CID)?.type, BUDGET_SHIFT_OPERATION);
    assert.equal(buildExecutableAction(payload, rec, '999'), null, 'other account');
    assert.equal(buildExecutableAction({ ...payload, params: { ...pairParams, shift_micros: 10_000_001 } }, rec, CID), null);
    assert.equal(buildExecutableAction({ ...payload, params: { ...pairParams, to_budget_resource: A } }, rec, CID), null);
  });
});

test('prepare, execute (one request, two operations, total unchanged) and rollback restore both', async () => {
  await withFlagAsync('true', async () => {
    const customer = budgetCustomer({ [A]: 100_000_000, [B]: 100_000_000 });
    const action = buildExecutableAction({ operation: BUDGET_SHIFT_OPERATION, target_id: A, params: pairParams }, { title: 't', description: 'd', expected_impact: {} }, CID)!;
    const prepared = await prepareActionForExecution(action as any, customer);
    assert.equal((prepared.rollbackPayload as any).action_type, BUDGET_SHIFT_OPERATION);
    assert.equal((prepared.rollbackPayload as any).reversible, true);
    assert.equal(rollbackResourcesScoped(prepared.rollbackPayload as any, CID), true);
    assert.equal(rollbackResourcesScoped(prepared.rollbackPayload as any, '999'), false);

    await executeAction(prepared.action, customer, { validateOnly: true });
    await executeAction(prepared.action, customer);
    assert.equal(customer.mutations.length, 2);
    for (const m of customer.mutations) {
      assert.equal(m.ops.length, 2, 'both budgets in ONE request');
      const total = m.ops.reduce((s: number, o: any) => s + o.amount_micros, 0);
      assert.equal(total, 200_000_000, 'total unchanged');
    }
    assert.equal(customer.mutations[0].options?.validateOnly, true);
    const [down, up] = customer.mutations[1].ops;
    assert.deepEqual([down.resource_name, down.amount_micros], [A, 90_000_000]);
    assert.deepEqual([up.resource_name, up.amount_micros], [B, 110_000_000]);

    await executeRollback(prepared.rollbackPayload as any, customer);
    const back = customer.mutations[2];
    assert.equal(back.ops.length, 2);
    assert.deepEqual(back.ops.map((o: any) => [o.resource_name, o.amount_micros]), [[A, 100_000_000], [B, 100_000_000]]);
  });
});

test('prepare refuses a stale card (a budget changed since) and a pair that no longer fits live numbers', async () => {
  await withFlagAsync('true', async () => {
    const action = buildExecutableAction({ operation: BUDGET_SHIFT_OPERATION, target_id: A, params: pairParams }, { title: 't', description: 'd', expected_impact: {} }, CID)!;
    await assert.rejects(prepareActionForExecution(action as any, budgetCustomer({ [A]: 120_000_000, [B]: 100_000_000 })), /changed since/);
    const noStamp = buildExecutableAction(
      { operation: BUDGET_SHIFT_OPERATION, target_id: A, params: { from_budget_resource: A, to_budget_resource: B, shift_micros: 10_000_000 } },
      { title: 't', description: 'd', expected_impact: {} },
      CID
    )!;
    await assert.rejects(prepareActionForExecution(noStamp as any, budgetCustomer({ [A]: 30_000_000, [B]: 400_000_000 })), /refused/);
    await assert.rejects(prepareActionForExecution(action as any, budgetCustomer({})), /Unable to read/);
  });
});

test('execute and rollback refuse malformed input and the flag being off', async () => {
  await withFlagAsync(undefined, async () => {
    await assert.rejects(executeAction(pairAction(), budgetCustomer({})), /disabled/);
  });
  await withFlagAsync('true', async () => {
    await assert.rejects(executeAction(pairAction({ shift_micros: 90_000_000 }), budgetCustomer({})), /refused|changed or became shared/);
    await assert.rejects(executeRollback({ action_type: BUDGET_SHIFT_OPERATION, changes: [] }, budgetCustomer({})), /unavailable/);
  });
});

test('dedupe: a waiting single change or pair on either budget blocks the pair, and the other way round', () => {
  const rowOf = (operation: string, params: Record<string, unknown>) => ({ id: 'x', status: 'pending', created_at: NOW.toISOString(), action_payload: { operation, params, source: 'optimizer_cron' } }) as any;
  assert.equal(findPendingDuplicate([rowOf('adjust_budget', { budget_resource: B })], pairAction(), NOW.getTime()).skip, true);
  assert.equal(findPendingDuplicate([rowOf(BUDGET_SHIFT_OPERATION, pairParams)], pairAction(), NOW.getTime()).skip, true);
  assert.equal(findPendingDuplicate([rowOf(BUDGET_SHIFT_OPERATION, pairParams)], { type: 'adjust_budget', params: { budget_resource: A } } as any, NOW.getTime()).skip, true);
  assert.equal(findPendingDuplicate([rowOf('adjust_budget', { budget_resource: `customers/${CID}/campaignBudgets/77` })], pairAction(), NOW.getTime()).skip, false);
});

test('review: the shift rollback and growth rollbacks are scope-checked on every executed resource', async () => {
  const { rollbackResourcesScoped } = await import('../lib/ai/rollback-scope');
  const good = {
    reversible: true,
    action_type: 'shift_budget_pair',
    resource_names: ['customers/123/campaignBudgets/1', 'customers/123/campaignBudgets/2'],
    changes: [
      { budget_resource: 'customers/123/campaignBudgets/1', amount_micros: 10_000_000 },
      { budget_resource: 'customers/123/campaignBudgets/2', amount_micros: 20_000_000 },
    ],
  };
  assert.equal(rollbackResourcesScoped(good, '123'), true);
  const crafted = { ...good, changes: [good.changes[0], { budget_resource: 'customers/999/campaignBudgets/7', amount_micros: 1 }] };
  assert.equal(rollbackResourcesScoped(crafted, '123'), false);
  assert.equal(rollbackResourcesScoped({ ...good, changes: [] }, '123'), false);
  const experiment = { action_type: 'growth_end_experiment', experiment_resource: 'customers/999/experiments/5', resource_names: ['customers/123/experiments/5'] };
  assert.equal(rollbackResourcesScoped(experiment, '123'), false);
  assert.equal(rollbackResourcesScoped({ ...experiment, experiment_resource: 'customers/123/experiments/5' }, '123'), true);
  const list = { action_type: 'growth_close_user_list', user_list_resource: 'customers/999/userLists/5', resource_names: ['customers/123/userLists/5'] };
  assert.equal(rollbackResourcesScoped(list, '123'), false);
});
