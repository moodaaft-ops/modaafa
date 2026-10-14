import type { AccountSignals, Scenario, UnderstoodRow } from './types';

/** CONTRACT (part B): the «فهمت عليك» rows, in the customer's words, before the plan. */
export function understandingRows(args: {
  scenario: Scenario;
  signals: AccountSignals | null;
  /** Ledger choice ids plus labels the screen already showed. */
  answered: Partial<Record<string, string | null>>;
  labels: Partial<Record<string, string>>;
  business: { name: string | null; monthlyBudget: number | null; targetRegions: string[] } | null;
}): UnderstoodRow[] {
  void args;
  return [];
}
