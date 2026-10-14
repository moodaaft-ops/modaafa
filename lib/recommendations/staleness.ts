/**
 * Stale pending optimizer recommendations.
 *
 * A pending recommendation the optimizer queued is a snapshot of one night's
 * numbers. After two weeks nobody can say the keyword still converts or the
 * budget is still constrained, and showing it as today's decision pushes the
 * owner to approve a change the optimizer itself would no longer propose.
 *
 * `recommendations.status` has no 'expired' value (the check constraint allows
 * pending, approved, executing, applied, dismissed and failed) and 'dismissed'
 * must not be used for this: a dismissed row blocks its fingerprint for good.
 * So staleness is decided at READ time, here, and every list of "what needs a
 * decision" drops these rows. The nightly cron renews a stale row in place
 * when the optimizer proposes the same change again (see
 * renewStalePendingRecommendation in lib/autopilot/recommendation-dedupe.ts).
 *
 * Only rows the optimizer queued are covered (see isOptimizerRecommendation).
 * The free audit's findings, a Jarvis card and an assistant draft are
 * something the owner asked for, and their age says nothing about whether the
 * optimizer would still propose them.
 *
 * A budget or bid card has a shorter life: the approval handler refuses to
 * execute an optimizer adjust_budget / adjust_bid older than 7 days
 * (isExpiredOptimizerMoneyMove), so such a card is stale after 7 days, not 14.
 * It leaves every list, stops holding its target and is renewed by the cron
 * through the same path, instead of sitting there as a card that errors on click.
 */

/** A pending optimizer recommendation older than this is no longer a current decision. */
export const STALE_PENDING_DAYS = 14;
export const STALE_PENDING_MS = STALE_PENDING_DAYS * 24 * 60 * 60 * 1000;

/** `action_payload.source` values the optimizer cron (and its autopilot paths) write. */
export const OPTIMIZER_RECOMMENDATION_SOURCES: readonly string[] = [
  'optimizer_cron',
  'autopilot_observe',
  'autopilot_fail_closed',
  'autopilot_quota_blocked',
];

export type StalenessCandidate = {
  status?: string | null;
  created_at?: string | null;
  action_payload?: unknown;
};

/**
 * The operations the optimizer cron queues. The free audit's findings use
 * `review_*`, `sync_campaigns`, `setup_conversion_tracking` and the like, which
 * are never in this list, so an old optimizer row written before `source` was
 * recorded can still be told apart from an audit finding.
 */
export const OPTIMIZER_OPERATIONS: readonly string[] = [
  'pause_keyword',
  'add_negative_keyword',
  'add_keyword',
  'adjust_budget',
  'adjust_bid',
  'pause_ad',
  'build_campaign_opportunity',
];

/**
 * True when the row was queued by the optimizer cron (or one of its autopilot
 * fallbacks). The recorded `source` decides; a row with no `source` at all (the
 * oldest rows) counts when its operation is one the optimizer queues. A row
 * with any other source (a Jarvis card, an assistant draft) never counts.
 */
export function isOptimizerRecommendation(row: StalenessCandidate | null | undefined): boolean {
  const payload = (row?.action_payload ?? null) as { source?: unknown; operation?: unknown } | null;
  const source = payload?.source;
  if (typeof source === 'string' && source.length > 0) return OPTIMIZER_RECOMMENDATION_SOURCES.includes(source);
  return typeof payload?.operation === 'string' && OPTIMIZER_OPERATIONS.includes(payload.operation);
}

/** True when a creation time is more than `lineMs` ago (14 days by default). An unreadable time is not past the line. */
export function isPastStaleLine(
  createdAt: string | null | undefined,
  nowMs: number = Date.now(),
  lineMs: number = STALE_PENDING_MS
): boolean {
  const created = createdAt ? Date.parse(createdAt) : Number.NaN;
  return Number.isFinite(created) && nowMs - created > lineMs;
}

/** The operation a recommendation's payload names ('' when it names none). */
function operationOf(row: StalenessCandidate | null | undefined): string {
  const operation = ((row?.action_payload ?? null) as { operation?: unknown } | null)?.operation;
  return typeof operation === 'string' ? operation : '';
}

/** A budget or bid card the optimizer queued: the kind that cannot be executed after 7 days. */
export function isOptimizerMoneyMove(row: StalenessCandidate | null | undefined): boolean {
  return Boolean(row) && MONEY_MOVE_OPERATIONS.includes(operationOf(row)) && isOptimizerRecommendation(row);
}

/** How old a PENDING row may be and still be a current decision: 7 days for an optimizer budget or bid card, else 14. */
export function pendingLineMs(row: StalenessCandidate | null | undefined): number {
  return isOptimizerMoneyMove(row) ? MONEY_MOVE_EXPIRY_DAYS * DAY_MS : STALE_PENDING_MS;
}

/**
 * True for a pending optimizer recommendation created more than 14 days ago
 * (7 days for a budget or bid card, which can no longer be executed after
 * that). A row with no readable timestamp is NOT stale: nothing proves its
 * age, so it keeps its current behavior.
 */
export function isStalePendingRecommendation(
  row: StalenessCandidate | null | undefined,
  nowMs: number = Date.now()
): boolean {
  if (!row || row.status !== 'pending') return false;
  if (!isOptimizerRecommendation(row)) return false;
  return isPastStaleLine(row.created_at, nowMs, pendingLineMs(row));
}

/** The rows that are still current decisions: everything except stale pending optimizer rows. */
export function dropStalePending<T extends StalenessCandidate>(
  rows: readonly T[] | null | undefined,
  nowMs: number = Date.now()
): T[] {
  return (rows ?? []).filter((row) => !isStalePendingRecommendation(row, nowMs));
}

/** ISO timestamp of the stale line: a pending row created before it is stale. */
export function staleCutoffIso(nowMs: number = Date.now()): string {
  return new Date(nowMs - STALE_PENDING_MS).toISOString();
}

// ---------------------------------------------------------------------------
// Locks and dedupe must not hold forever
// ---------------------------------------------------------------------------

/** A card stuck in `executing` longer than this is a crashed run, not a change in flight. */
export const STUCK_EXECUTING_HOURS = 24;
/** A card `approved` and never executed for this long no longer reserves its target. */
export const STUCK_APPROVED_DAYS = 7;
/** An optimizer budget or bid card older than this is not executable: its numbers belong to another week. */
export const MONEY_MOVE_EXPIRY_DAYS = 7;
/** The operations that move money or the bidding strategy, the ones with a short shelf life. */
export const MONEY_MOVE_OPERATIONS: readonly string[] = ['adjust_budget', 'adjust_bid'];

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export type LockHoldingCandidate = StalenessCandidate & {
  /** Set when the approval handler claimed the row (status `executing`). */
  execution_started_at?: string | null;
};

/** True when a timestamp is more than `ms` ago. An unreadable time is not past the line. */
function olderThan(timestamp: string | null | undefined, ms: number, nowMs: number): boolean {
  const at = timestamp ? Date.parse(timestamp) : Number.NaN;
  return Number.isFinite(at) && nowMs - at > ms;
}

/**
 * Does this recommendation still reserve its target (the per-target locks in
 * checkGuardrails and the queue-time dedupe)? A row that can no longer be acted
 * on must not block the optimizer for good:
 *
 *   pending     a current decision for 14 days, whoever created it; after that
 *               nobody can say the numbers still hold (an optimizer budget or
 *               bid card, which cannot be executed after 7 days, holds for 7)
 *   approved    7 days from creation; an approval nobody executed for a week
 *   executing   24 hours from the claim (`execution_started_at`, else creation);
 *               a longer claim is a crashed run, the same condition the
 *               ops alerts already treat as stuck
 *
 * A status this function does not know (and a row with no status) keeps
 * holding, as before: only the three states above can expire.
 */
export function holdsTargetLock(row: LockHoldingCandidate | null | undefined, nowMs: number = Date.now()): boolean {
  if (!row) return false;
  switch (row.status) {
    case 'pending':
      return !isPastStaleLine(row.created_at, nowMs, pendingLineMs(row));
    case 'approved':
      return !olderThan(row.created_at, STUCK_APPROVED_DAYS * DAY_MS, nowMs);
    case 'executing':
      return !olderThan(row.execution_started_at ?? row.created_at, STUCK_EXECUTING_HOURS * HOUR_MS, nowMs);
    default:
      return true;
  }
}

/**
 * An optimizer-queued budget or bid card that is more than 7 days old. The
 * overnight run proposed it against that night's numbers and a lock window of
 * one week; executing it later would move money on evidence from another
 * week, and the executed-history locks may not have existed when it was
 * queued. Cards from Jarvis or the assistant are the owner's own request and
 * never expire here.
 */
export function isExpiredOptimizerMoneyMove(
  row: StalenessCandidate | null | undefined,
  operation: string,
  nowMs: number = Date.now()
): boolean {
  if (!row || !MONEY_MOVE_OPERATIONS.includes(operation)) return false;
  if (!isOptimizerRecommendation(row)) return false;
  return olderThan(row.created_at, MONEY_MOVE_EXPIRY_DAYS * DAY_MS, nowMs);
}

