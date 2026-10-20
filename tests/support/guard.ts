import { addDaysYmd } from '../../lib/guard/time';
import type { DailyRow, GuardSignals, GuardSource } from '../../lib/guard/types';

/** 05:30 Riyadh on 19 Oct 2026. Yesterday in the account zone is 2026-10-18. */
export const NOW = new Date('2026-10-19T02:30:00Z');
export const YESTERDAY = '2026-10-18';

export const ALL_OK: Record<GuardSource, boolean> = { status: true, daily: true, campaigns: true, ads: true, billing: true, changes: true };

export function baseSignals(overrides: Partial<GuardSignals> = {}): GuardSignals {
  return {
    accountId: 'acc-1',
    customerId: '1234567890',
    currency: 'SAR',
    timeZone: 'Asia/Riyadh',
    now: NOW,
    today: '2026-10-19',
    yesterday: YESTERDAY,
    googleStatus: 'ENABLED',
    daily: [],
    campaigns: [],
    ads: [],
    billing: { setupStatuses: ['APPROVED'], budgets: [] },
    changes: [],
    ownActions: [],
    ok: { ...ALL_OK },
    ...overrides,
  };
}

/**
 * One campaign's rows: `baseline` is the 14 days before yesterday (oldest first),
 * `yesterday` is yesterday's cost. A day with cost 0 and no conversions has no row, like Google.
 */
export function campaignRows(
  id: string,
  name: string,
  spec: { baseline: number[]; yesterday: number; conv?: number[]; yesterdayConv?: number; clicks?: number; yesterdayClicks?: number }
): DailyRow[] {
  const rows: DailyRow[] = [];
  const push = (date: string, cost: number, conversions: number, clicks: number) => {
    if (cost === 0 && conversions === 0) return;
    rows.push({ campaignId: id, campaignName: name, date, cost, conversions, clicks, impressions: clicks * 10 });
  };
  spec.baseline.forEach((cost, index) => {
    push(addDaysYmd(YESTERDAY, -(14 - index)), cost, spec.conv?.[index] ?? 0, spec.clicks ?? (cost > 0 ? 20 : 0));
  });
  push(YESTERDAY, spec.yesterday, spec.yesterdayConv ?? 0, spec.yesterdayClicks ?? (spec.yesterday > 0 ? 20 : 0));
  return rows;
}

export const flat = (value: number, days = 14) => Array.from({ length: days }, () => value);

export function campaignInfo(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name,
    status: 'ENABLED',
    dailyBudget: 150,
    primaryStatus: 'ELIGIBLE',
    primaryReasons: [] as string[],
    budgetLostIs: null,
    rankLostIs: null,
    impressionShare: null,
    baselineImpressionShare: null,
    ...extra,
  };
}
