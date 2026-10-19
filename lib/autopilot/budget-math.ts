/** Pure budget math shared by the autonomy policy and the paired budget shift. No imports on purpose (no cycles). */

/** A budget move may shift at most this share of the total, and never raise the total. */
export const AUTONOMY_BUDGET_SHIFT_MAX_PCT = 10;

export type BudgetChange = {
  budget_resource: string;
  current_amount_micros: number;
  new_amount_micros: number;
};

export type BudgetShiftVerdict =
  | { ok: true; total_micros: number; moved_micros: number }
  | { ok: false; code: 'raises_total_spend' | 'shift_too_large' | 'shape_invalid' };

/**
 * A budget move between campaigns is automatic only when it is a pure shift:
 * the new total is not above the old total, no single budget moves by more than
 * 10% of the total, at least one budget goes up and one goes down. Any change
 * that raises the total is rejected, however it is split. Pure.
 */
export function evaluateBudgetShift(changes: BudgetChange[]): BudgetShiftVerdict {
  if (!Array.isArray(changes) || changes.length < 2 || changes.length > 6) {
    return { ok: false, code: 'shape_invalid' };
  }
  const seen = new Set<string>();
  let oldTotal = 0;
  let newTotal = 0;
  for (const change of changes) {
    const resource = String(change?.budget_resource ?? '');
    const before = Number(change?.current_amount_micros);
    const after = Number(change?.new_amount_micros);
    if (!resource || seen.has(resource)) return { ok: false, code: 'shape_invalid' };
    seen.add(resource);
    if (!Number.isFinite(before) || !Number.isFinite(after) || before <= 0 || after <= 0) {
      return { ok: false, code: 'shape_invalid' };
    }
    oldTotal += before;
    newTotal += after;
  }
  // The ceiling: compare exact micros, no tolerance. A shift that adds even one
  // micro to the total is a raise.
  if (newTotal > oldTotal) return { ok: false, code: 'raises_total_spend' };

  const hasUp = changes.some((c) => c.new_amount_micros > c.current_amount_micros);
  const hasDown = changes.some((c) => c.new_amount_micros < c.current_amount_micros);
  if (!hasUp || !hasDown) return { ok: false, code: 'shape_invalid' };

  const maxMove = (oldTotal * AUTONOMY_BUDGET_SHIFT_MAX_PCT) / 100;
  let moved = 0;
  for (const change of changes) {
    const delta = Math.abs(change.new_amount_micros - change.current_amount_micros);
    if (delta > maxMove) return { ok: false, code: 'shift_too_large' };
    if (change.new_amount_micros > change.current_amount_micros) moved += delta;
  }
  return { ok: true, total_micros: oldTotal, moved_micros: moved };
}

