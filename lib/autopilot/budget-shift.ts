import { accountCpa30dFromSnapshot, evaluateBudgetBounds, evaluateBudgetGate, pick, numOrNull, readCampaignEntries, type GateContext, type GateVerdict } from '@/lib/ai/optimizer-gates';
import type { OptimizerAction } from '@/lib/ai/optimizer-agent';
import { AUTONOMY_BUDGET_SHIFT_MAX_PCT, evaluateBudgetShift, type BudgetChange } from './budget-math';

/**
 * shift_budget_pair: move money from one campaign budget to another in ONE
 * mutate request (decrease A, increase B by the same amount). The total daily
 * spend is unchanged by construction and re-checked in exact micros at every
 * stage. Behind AUTONOMY_LEVELS_ENABLED. Never proposed by the model: the
 * proposer below is rules over the optimizer snapshot.
 *
 * Executes through the existing machinery: checkGuardrails, prepareActionForExecution
 * (live read + rollback payload), validateOnly, a single campaignBudgets.update with
 * both operations, and a rollback that restores both in one request.
 */

export const BUDGET_SHIFT_OPERATION = 'shift_budget_pair';
/** Google budgets are whole currency cents. */
export const WHOLE_CENT_MICROS = 10_000;

export type ShiftParams = {
  from_budget_resource: string;
  to_budget_resource: string;
  shift_micros: number;
  /** What the proposer saw. When present the live budget must still match, or the card is stale. */
  from_current_micros?: number;
  to_current_micros?: number;
};

export type ShiftParamsResult = { ok: true; value: ShiftParams } | { ok: false; code: string };

export function readShiftParams(params: Record<string, unknown> | null | undefined, validResource: (value: string) => boolean): ShiftParamsResult {
  const from = String(params?.from_budget_resource ?? '');
  const to = String(params?.to_budget_resource ?? '');
  const shift = Number(params?.shift_micros);
  if (!validResource(from) || !validResource(to) || from === to) return { ok: false, code: 'shift_resources_invalid' };
  if (!Number.isSafeInteger(shift) || shift <= 0 || shift % WHOLE_CENT_MICROS !== 0) return { ok: false, code: 'shift_amount_invalid' };
  const value: ShiftParams = { from_budget_resource: from, to_budget_resource: to, shift_micros: shift };
  for (const key of ['from_current_micros', 'to_current_micros'] as const) {
    if (params?.[key] === undefined) continue;
    const n = Number(params[key]);
    if (!Number.isSafeInteger(n) || n <= 0) return { ok: false, code: 'shift_amount_invalid' };
    value[key] = n;
  }
  return { ok: true, value };
}

export type PairAmountsResult =
  | { ok: true; changes: [BudgetChange, BudgetChange]; total_micros: number }
  | { ok: false; code: string };

/**
 * Pure. The pair's math on exact micros. `accountTotalMicros` (the sum of all
 * enabled daily budgets, when known) adds a second ceiling: the move may not
 * exceed 10% of it either.
 */
export function evaluatePairAmounts(args: {
  from: string;
  to: string;
  fromAmount: number;
  toAmount: number;
  shiftMicros: number;
  accountTotalMicros?: number | null;
}): PairAmountsResult {
  const { fromAmount, toAmount, shiftMicros } = args;
  if (![fromAmount, toAmount, shiftMicros].every((n) => Number.isSafeInteger(n) && n > 0)) return { ok: false, code: 'shift_amount_invalid' };
  if (shiftMicros % WHOLE_CENT_MICROS !== 0) return { ok: false, code: 'shift_amount_invalid' };
  if (shiftMicros >= fromAmount) return { ok: false, code: 'shift_empties_budget' };
  const changes: [BudgetChange, BudgetChange] = [
    { budget_resource: args.from, current_amount_micros: fromAmount, new_amount_micros: fromAmount - shiftMicros },
    { budget_resource: args.to, current_amount_micros: toAmount, new_amount_micros: toAmount + shiftMicros },
  ];
  // Each leg is an ordinary budget step: 5 to 20% of its own budget.
  for (const c of changes) {
    const bounds = evaluateBudgetBounds({
      current_amount_micros: c.current_amount_micros,
      new_amount_micros: c.new_amount_micros,
      delta_pct: ((c.new_amount_micros - c.current_amount_micros) / c.current_amount_micros) * 100,
    });
    if (!bounds.ok) return { ok: false, code: bounds.code };
  }
  const shift = evaluateBudgetShift(changes);
  if (!shift.ok) return { ok: false, code: shift.code };
  // By construction equal; asserted so a future edit cannot break it silently.
  const oldTotal = changes[0].current_amount_micros + changes[1].current_amount_micros;
  const newTotal = changes[0].new_amount_micros + changes[1].new_amount_micros;
  if (newTotal > oldTotal) return { ok: false, code: 'raises_total_spend' };
  if (args.accountTotalMicros && shiftMicros > (args.accountTotalMicros * AUTONOMY_BUDGET_SHIFT_MAX_PCT) / 100) {
    return { ok: false, code: 'shift_too_large' };
  }
  return { ok: true, changes, total_micros: oldTotal };
}

// ---------------------------------------------------------------------------
// Snapshot side
// ---------------------------------------------------------------------------

type Snapshot = GateContext['snapshot'];

export function budgetAmountsFromSnapshot(snapshot: Pick<Snapshot, 'campaigns'>): { byBudget: Map<string, { amount: number; campaigns: number; campaign_name: string }>; total: number } {
  const byBudget = new Map<string, { amount: number; campaigns: number; campaign_name: string }>();
  const rows = Array.isArray(snapshot.campaigns) ? snapshot.campaigns : [];
  for (const row of rows) {
    const budget = (row as any)?.campaign_budget ?? (row as any)?.campaignBudget ?? {};
    const resource = String(pick(budget, 'resource_name') ?? '');
    const amount = numOrNull(pick(budget, 'amount_micros'));
    if (!resource || amount === null || amount <= 0) continue;
    const entry = byBudget.get(resource);
    if (entry) entry.campaigns += 1;
    else byBudget.set(resource, { amount, campaigns: 1, campaign_name: String(pick(row, 'campaign.name') ?? '') });
  }
  let total = 0;
  for (const v of byBudget.values()) total += v.amount;
  return { byBudget, total };
}

const leg = (resource: string, pct: number): OptimizerAction => ({
  type: 'adjust_budget',
  target_id: resource,
  params: { budget_resource: resource, delta_pct: pct },
  reason_ar: '',
  reason_en: '',
  expected_impact: { metric: 'conversions', delta_pct: 0, delta_sar_per_month: 0 },
});

/**
 * Queue-time gate: the same cut gate the single budget cut uses for the budget
 * that gives, the same scale gate the single budget raise uses for the budget
 * that receives, and the exact-micros pair math on the snapshot's amounts.
 */
export function evaluatePairGate(params: Record<string, unknown>, snapshot: Snapshot, validResource: (v: string) => boolean): GateVerdict {
  const read = readShiftParams(params, validResource);
  if (!read.ok) return { ok: false, code: read.code };
  const { from_budget_resource: from, to_budget_resource: to, shift_micros: shift } = read.value;
  const { byBudget, total } = budgetAmountsFromSnapshot(snapshot);
  const a = byBudget.get(from);
  const b = byBudget.get(to);
  if (!a || !b) return { ok: false, code: 'budget_not_in_snapshot' };
  // A shared budget moves several campaigns at once; this feature does not touch those.
  if (a.campaigns !== 1 || b.campaigns !== 1) return { ok: false, code: 'shared_budget' };
  const amounts = evaluatePairAmounts({ from, to, fromAmount: a.amount, toAmount: b.amount, shiftMicros: shift, accountTotalMicros: total });
  if (!amounts.ok) return amounts;
  const context = { snapshot } as GateContext;
  const cpa = accountCpa30dFromSnapshot(snapshot);
  const give = evaluateBudgetGate(leg(from, -((shift / a.amount) * 100)), context, cpa);
  if (!give.ok) return { ok: false, code: `from_${give.code}` };
  const take = evaluateBudgetGate(leg(to, (shift / b.amount) * 100), context, cpa);
  if (!take.ok) return { ok: false, code: `to_${take.code}` };
  return { ok: true };
}

/**
 * Rules, not a model: the clearest losing single-campaign budget gives to the
 * clearest winning single-campaign budget that runs out of budget early. The
 * move is the largest whole-cent amount inside every ceiling. Null when no pair
 * qualifies.
 */
export function proposeBudgetShift(snapshot: Snapshot, validResource: (v: string) => boolean, currencyCode = 'SAR'): (OptimizerAction & { confidence: number }) | null {
  const { byBudget, total } = budgetAmountsFromSnapshot(snapshot);
  if (byBudget.size < 2) return null;
  const context = { snapshot } as GateContext;
  const cpa = accountCpa30dFromSnapshot(snapshot);
  const entries = readCampaignEntries(snapshot).filter((e) => byBudget.get(e.budgetResource)?.campaigns === 1);

  const givers = entries
    .filter((e) => evaluateBudgetGate(leg(e.budgetResource, -10), context, cpa).ok)
    .sort((x, y) => (y.last30d?.cost_micros ?? 0) - (x.last30d?.cost_micros ?? 0));
  const takers = entries
    .filter((e) => evaluateBudgetGate(leg(e.budgetResource, 10), context, cpa).ok)
    .sort((x, y) => (y.last30d?.conversions ?? 0) - (x.last30d?.conversions ?? 0));

  for (const giver of givers) {
    for (const taker of takers) {
      if (giver.budgetResource === taker.budgetResource) continue;
      const a = byBudget.get(giver.budgetResource)!;
      const b = byBudget.get(taker.budgetResource)!;
      const cap = Math.min(0.2 * a.amount, 0.2 * b.amount, (AUTONOMY_BUDGET_SHIFT_MAX_PCT / 100) * (a.amount + b.amount), (AUTONOMY_BUDGET_SHIFT_MAX_PCT / 100) * total);
      const shift = Math.floor(cap / WHOLE_CENT_MICROS) * WHOLE_CENT_MICROS;
      if (shift <= 0) continue;
      const params: Record<string, unknown> = {
        from_budget_resource: giver.budgetResource,
        to_budget_resource: taker.budgetResource,
        shift_micros: shift,
        from_current_micros: a.amount,
        to_current_micros: b.amount,
      };
      if (!evaluatePairGate(params, snapshot, validResource).ok) continue;
      const amount = (shift / 1_000_000).toFixed(2);
      return {
        type: BUDGET_SHIFT_OPERATION as OptimizerAction['type'],
        target_id: giver.budgetResource,
        params,
        confidence: 1,
        reason_ar: `ننقل ${amount} ${currencyCode} من ميزانية حملة "${giver.name}" اللي تصرف وما تجيب بسعر مناسب، إلى حملة "${taker.name}" اللي تجيب نتيجة وميزانيتها تخلص بدري. إجمالي الميزانية اليومية ما يتغير.`,
        reason_en: `Shift budget from ${giver.name} to ${taker.name} (total unchanged)`,
        expected_impact: { metric: 'conversions', delta_pct: 0, delta_sar_per_month: 0 },
      } as OptimizerAction & { confidence: number };
    }
  }
  return null;
}
