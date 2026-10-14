import { hasBreakEven, type BreakEven } from '../economics/break-even';
import type { OptimizerAction, OptimizerSnapshot } from './optimizer-agent';

/**
 * Deterministic gates for what the optimizer is allowed to propose, checked in
 * code at queue time so the model's compliance with the prompt is not the only
 * thing between a mistaken number and a live budget.
 *
 * Pure: every function takes the snapshot the model was shown and returns a
 * verdict. checkGuardrails (optimizer-agent.ts) adds the parts that need the
 * database (the per-target locks) on top.
 *
 * Imports only TYPES from optimizer-agent.ts. That file imports this one, so a
 * value import back would be a cycle.
 *
 * Thresholds come from the google-ads-titan knowledge base:
 *   5.2 / 5.3   a step is 10 to 20%, one change per 1-2 weeks; 20% or more
 *               resets learning on a smart strategy
 *   6.2         vertical scaling is 10-20% per 7-14 days
 *   6.4         lost impression share to budget is the opportunity; lost to
 *               rank is not fixed with money. The KB says "Lost IS (budget)
 *               فوق 20%" with performance inside the target is a scale
 *               opportunity, so the scale gate floor is 0.20 (a share of
 *               exactly 20% passes; the share is a float, so the boundary is
 *               not a meaningful distinction)
 *   6.5         scale only what is profitable with enough conversions
 *   SKILL red rules 2, 5, 6, 8: targets from the client's economics, no
 *               money decisions on broken tracking, one change per week
 */

// ---------------------------------------------------------------------------
// Constants (the system prompt states the same numbers; a test keeps them equal)
// ---------------------------------------------------------------------------

/** A budget step is at most this many percent up or down. */
export const BUDGET_STEP_MAX_PCT = 20;
/** A step smaller than this is noise, not an optimization. */
export const BUDGET_STEP_MIN_PCT = 5;
export const BUDGET_LOCK_DAYS = 7;
export const BID_LOCK_DAYS = 14;

/** Raise a budget only for a campaign that earns clearly more than break-even. */
export const SCALE_ROAS_FACTOR = 1.2;
export const SCALE_CPA_FACTOR = 0.8;
export const SCALE_MIN_CONVERSIONS_30D = 15;
/** titan bidding-budget.md 6.4: lost impression share to budget above 20%. */
export const SCALE_MIN_LOST_BUDGET_IS = 0.2;
export const SCALE_MAX_SEARCH_IS = 0.5;

/** Cut a budget only for a campaign that is clearly losing money on enough spend. */
export const CUT_CPA_FACTOR = 1.5;
export const CUT_MIN_SPEND_IN_CPAS = 2;

/** A target-based bid change needs this many conversions in 30 days on the campaign. */
export const BID_MIN_CONVERSIONS_30D = 30;

const PCT_EPSILON = 1e-4;
const HALF_CENT_MICROS = 5_000;

/** Tracking statuses the cron can put in the snapshot. Only 'healthy' unlocks money moves. */
export const TRACKING_HEALTHY = 'healthy';

/** Action types that read conversion numbers and so need trustworthy tracking. */
export const TRACKING_GATED_ACTIONS: ReadonlySet<string> = new Set([
  'adjust_budget',
  'adjust_bid',
  'pause_keyword',
  'pause_ad',
]);

// ---------------------------------------------------------------------------
// Reading the snapshot
// ---------------------------------------------------------------------------

/** The diagnostics the cron attaches to each campaign row (null when Google gave none). */
export type CampaignDiag = {
  type: string | null;
  bidding: string | null;
  primary_status: string | null;
  status_reasons: string[];
  impressions_7d: number | null;
  search_is: number | null;
  lost_budget_is: number | null;
  lost_rank_is: number | null;
};

/** Cost, conversions and value of a campaign over the last 30 days. */
export type Campaign30d = {
  cost_micros: number;
  conversions: number;
  conversions_value: number;
};

export type CampaignEntry = {
  resource: string;
  name: string;
  budgetResource: string;
  diag: CampaignDiag | null;
  last30d: Campaign30d | null;
};

function camel(segment: string) {
  return segment.replace(/_([a-z])/g, (_m, letter: string) => letter.toUpperCase());
}

/** `a.b_c` read from a row that may use snake_case or camelCase keys. */
function pick(row: unknown, path: string): unknown {
  let current: unknown = row;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    const object = current as Record<string, unknown>;
    const c = camel(segment);
    current = object[c] !== undefined ? object[c] : object[segment];
  }
  return current;
}

export function numOrNull(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function strOrEmpty(value: unknown): string {
  return value === undefined || value === null ? '' : String(value);
}

/** Campaign rows of the snapshot, normalized. Rows without a resource name are dropped. */
export function readCampaignEntries(snapshot: Pick<OptimizerSnapshot, 'campaigns'>): CampaignEntry[] {
  const out: CampaignEntry[] = [];
  for (const row of Array.isArray(snapshot.campaigns) ? snapshot.campaigns : []) {
    const resource = strOrEmpty(pick(row, 'campaign.resource_name'));
    if (!resource) continue;
    const budget = (row as any)?.campaign_budget ?? (row as any)?.campaignBudget ?? {};
    const diag = (row as any)?.diag;
    const last30 = (row as any)?.last_30d;
    out.push({
      resource,
      name: strOrEmpty(pick(row, 'campaign.name')),
      budgetResource: strOrEmpty(pick(budget, 'resource_name')),
      diag: diag && typeof diag === 'object' ? (diag as CampaignDiag) : null,
      last30d:
        last30 && typeof last30 === 'object'
          ? {
              cost_micros: numOrNull(last30.cost_micros) ?? 0,
              conversions: numOrNull(last30.conversions) ?? 0,
              conversions_value: numOrNull(last30.conversions_value) ?? 0,
            }
          : null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Verdict plumbing
// ---------------------------------------------------------------------------

export type GateVerdict = { ok: true } | { ok: false; code: string };

const ok: GateVerdict = { ok: true };
const no = (code: string): GateVerdict => ({ ok: false, code });

/** What the validator knows about the account beyond the single action. */
export type GateContext = {
  snapshot: Pick<OptimizerSnapshot, 'campaigns' | 'conversion_tracking' | 'economics' | 'ad_group_bid_targets'>;
};

function trackingHealthy(context: GateContext) {
  return context.snapshot.conversion_tracking?.status === TRACKING_HEALTHY;
}

// ---------------------------------------------------------------------------
// Tracking gate (every action that reads conversion numbers)
// ---------------------------------------------------------------------------

export function evaluateTrackingGate(action: OptimizerAction, context: GateContext): GateVerdict {
  if (!TRACKING_GATED_ACTIONS.has(action.type)) return ok;
  return trackingHealthy(context) ? ok : no('tracking_not_healthy');
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

/** The change in percent, from the amounts when the action names both, else from delta_pct. */
export function effectiveBudgetDeltaPct(params: Record<string, unknown>): number | null {
  const declared = numOrNull(params.delta_pct);
  const current = numOrNull(params.current_amount_micros);
  const next = numOrNull(params.new_amount_micros);
  if (current !== null && current > 0 && next !== null && next > 0) {
    const implied = ((next - current) / current) * 100;
    // The amount is what executes, the percent is what gets checked: they must agree.
    if (declared === null || Math.abs(implied - declared) > 1) return null;
    return implied;
  }
  return declared;
}

/** Bounds every budget change must satisfy, whoever proposes it and whenever it is checked. */
export function evaluateBudgetBounds(params: Record<string, unknown>): GateVerdict {
  const delta = effectiveBudgetDeltaPct(params);
  if (delta === null || !Number.isFinite(delta)) return no('budget_delta_invalid');
  // Google budgets are whole cents: a +20% asked on 12.37 lands on the nearest
  // cent, which can read as 20.04%. Half a cent of slack, never more.
  const current = numOrNull(params.current_amount_micros);
  const slack = current !== null && current > 0 ? (HALF_CENT_MICROS / current) * 100 : 0;
  const size = Math.abs(delta);
  if (size > BUDGET_STEP_MAX_PCT + slack + PCT_EPSILON) return no('budget_step_too_large');
  if (size < BUDGET_STEP_MIN_PCT - slack - PCT_EPSILON) return no('budget_step_too_small');
  return ok;
}

type BudgetGroup = {
  entries: CampaignEntry[];
  cost: number;
  conversions: number;
  value: number;
  complete: boolean;
};

/** Every enabled campaign that spends from this budget (a shared budget has several). */
function budgetGroup(snapshot: GateContext['snapshot'], budgetResource: string): BudgetGroup {
  const entries = readCampaignEntries(snapshot).filter((entry) => entry.budgetResource === budgetResource);
  let cost = 0;
  let conversions = 0;
  let value = 0;
  let complete = entries.length > 0;
  for (const entry of entries) {
    if (!entry.last30d) {
      complete = false;
      continue;
    }
    cost += entry.last30d.cost_micros / 1_000_000;
    conversions += entry.last30d.conversions;
    value += entry.last30d.conversions_value;
  }
  return { entries, cost, conversions, value, complete };
}

/**
 * Is the campaign (or the shared budget's campaigns together) clearly more
 * profitable than break-even, on enough conversions to believe it?
 */
function earnsClearlyMoreThanBreakEven(group: BudgetGroup, economics: BreakEven): boolean {
  if (group.conversions < SCALE_MIN_CONVERSIONS_30D) return false;
  if (economics.break_even_roas !== null) {
    // No tracked value means ROAS is unusable, so profitability cannot be shown.
    if (!(group.cost > 0) || !(group.value > 0)) return false;
    return group.value / group.cost >= SCALE_ROAS_FACTOR * economics.break_even_roas;
  }
  if (economics.break_even_cpa !== null) {
    if (!(group.conversions > 0)) return false;
    return group.cost / group.conversions <= SCALE_CPA_FACTOR * economics.break_even_cpa;
  }
  return false;
}

/**
 * Is the campaign clearly losing money on enough spend to justify cutting its
 * budget? `spendFloor` is two break-even CPAs when the client has one; for an
 * e-commerce store (break-even ROAS only) the caller passes two of the
 * account's own CPAs, which only says "enough spend was tried".
 */
function losesClearlyOnEnoughSpend(group: BudgetGroup, economics: BreakEven, spendFloor: number | null): boolean {
  if (spendFloor === null || !(group.cost >= spendFloor)) return false;
  if (economics.break_even_cpa !== null) {
    if (group.conversions === 0) return true;
    return group.cost / group.conversions >= CUT_CPA_FACTOR * economics.break_even_cpa;
  }
  if (economics.break_even_roas !== null) {
    // Conversions with no tracked value say nothing about ROAS: do not cut on a missing number.
    if (group.conversions > 0 && !(group.value > 0)) return false;
    return group.value / (group.cost || 1) <= economics.break_even_roas / CUT_CPA_FACTOR;
  }
  return false;
}

function budgetIsConstrained(group: BudgetGroup): boolean {
  const diags = group.entries.map((entry) => entry.diag).filter((diag): diag is CampaignDiag => Boolean(diag));
  const lost = diags.map((d) => d.lost_budget_is).filter((v): v is number => typeof v === 'number');
  const share = diags.map((d) => d.search_is).filter((v): v is number => typeof v === 'number');
  const hasImpressionShare = lost.length > 0 || share.length > 0;

  if (hasImpressionShare) {
    // Search campaigns: lost-to-budget must be a real opportunity and there must be room to grow.
    if (lost.length > 0 && Math.max(...lost) < SCALE_MIN_LOST_BUDGET_IS) return false;
    if (share.length > 0 && Math.max(...share) >= SCALE_MAX_SEARCH_IS) return false;
    return true;
  }
  // No impression share (Performance Max, Demand Gen, Shopping): Google's own status must say so.
  return diags.some((d) => Array.isArray(d.status_reasons) && d.status_reasons.includes('BUDGET_CONSTRAINED'));
}

/**
 * Queue-time gate for adjust_budget, on top of the bounds. `spendFloorBasis`
 * is the account's own 30-day CPA, used only as the "enough spend" floor for a
 * ROAS-based cut (see losesClearlyOnEnoughSpend).
 */
export function evaluateBudgetGate(
  action: OptimizerAction,
  context: GateContext,
  accountCpa30d: number | null
): GateVerdict {
  const params = action.params as Record<string, unknown>;
  const delta = effectiveBudgetDeltaPct(params);
  if (delta === null) return no('budget_delta_invalid');

  if (!trackingHealthy(context)) return no('tracking_not_healthy');
  const economics = context.snapshot.economics ?? null;
  if (!economics || !hasBreakEven(economics)) return no('economics_unknown');

  const budgetResource = strOrEmpty(params.budget_resource);
  const group = budgetGroup(context.snapshot, budgetResource);
  if (group.entries.length === 0) return no('budget_not_in_snapshot');
  if (!group.complete) return no('campaign_30d_unavailable');

  if (delta > 0) {
    if (!earnsClearlyMoreThanBreakEven(group, economics)) return no('scale_gate_not_met');
    if (!budgetIsConstrained(group)) return no('budget_not_constrained');
    return ok;
  }

  const spendFloor =
    economics.break_even_cpa !== null
      ? CUT_MIN_SPEND_IN_CPAS * economics.break_even_cpa
      : accountCpa30d !== null && accountCpa30d > 0
        ? CUT_MIN_SPEND_IN_CPAS * accountCpa30d
        : null;
  return losesClearlyOnEnoughSpend(group, economics, spendFloor) ? ok : no('cut_gate_not_met');
}

// ---------------------------------------------------------------------------
// Bids
// ---------------------------------------------------------------------------

/**
 * Queue-time gate for adjust_bid, on top of the +-20% bound. The new target
 * must respect the client's break-even (a tCPA never above break-even CPA, a
 * tROAS never below break-even ROAS) and the campaign must have enough
 * conversions in 30 days for a target to mean anything.
 */
export function evaluateBidGate(action: OptimizerAction, context: GateContext): GateVerdict {
  if (!trackingHealthy(context)) return no('tracking_not_healthy');
  const economics = context.snapshot.economics ?? null;
  if (!economics || !hasBreakEven(economics)) return no('economics_unknown');

  const params = action.params as Record<string, unknown>;
  const adGroupResource = strOrEmpty(params.ad_group_resource);
  const target = (context.snapshot.ad_group_bid_targets ?? []).find(
    (row: any) => strOrEmpty(pick(row, 'ad_group.resource_name')) === adGroupResource
  );
  if (!target) return no('ad_group_not_in_snapshot');

  const campaignResource = strOrEmpty(pick(target, 'ad_group.campaign'));
  const campaign = readCampaignEntries(context.snapshot).find((entry) => entry.resource === campaignResource);
  if (!campaign?.last30d) return no('campaign_30d_unavailable');
  if (campaign.last30d.conversions < BID_MIN_CONVERSIONS_30D) return no('bid_needs_more_conversions');

  const nextCpaMicros = numOrNull(params.target_cpa_micros);
  const nextRoas = numOrNull(params.target_roas);
  if (nextCpaMicros !== null) {
    if (economics.break_even_cpa === null) return no('no_cpa_break_even');
    if (nextCpaMicros / 1_000_000 > economics.break_even_cpa) return no('target_cpa_above_break_even');
  } else if (nextRoas !== null) {
    if (economics.break_even_roas === null) return no('no_roas_break_even');
    if (nextRoas < economics.break_even_roas) return no('target_roas_below_break_even');
  } else {
    return no('bid_target_missing');
  }
  return ok;
}

// ---------------------------------------------------------------------------
// Locks (the database part lives in checkGuardrails; the matching is here)
// ---------------------------------------------------------------------------

export type LockRow = { operation: string; resource: string; at: string | null };

/** True when one of the rows is the same kind of change on the same target inside the window. */
export function lockedByRecentChange(
  rows: LockRow[],
  operation: string,
  resource: string,
  days: number,
  nowMs: number
): boolean {
  if (!resource) return false;
  const cutoff = nowMs - days * 24 * 60 * 60 * 1000;
  return rows.some((row) => {
    if (row.operation !== operation || row.resource !== resource) return false;
    // A row with no usable timestamp counts as recent: the query already limited the window.
    if (!row.at) return true;
    const at = Date.parse(row.at);
    return !Number.isFinite(at) || at >= cutoff;
  });
}

/** `ai_actions.payload` of an executed change -> the params of the action. */
export function executedParams(payload: unknown): Record<string, unknown> {
  const p = payload as any;
  return (p?.action?.params ?? p?.params ?? p ?? {}) as Record<string, unknown>;
}

/** The account's own 30-day CPA from the campaign rows (null when nothing converted). */
export function accountCpa30dFromSnapshot(snapshot: Pick<OptimizerSnapshot, 'campaigns'>): number | null {
  let cost = 0;
  let conversions = 0;
  for (const entry of readCampaignEntries(snapshot)) {
    if (!entry.last30d) continue;
    cost += entry.last30d.cost_micros / 1_000_000;
    conversions += entry.last30d.conversions;
  }
  return conversions > 0 && cost > 0 ? cost / conversions : null;
}
