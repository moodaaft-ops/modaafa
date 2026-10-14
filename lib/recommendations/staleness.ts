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

/** True when a creation time is more than 14 days ago. An unreadable time is not past the line. */
export function isPastStaleLine(createdAt: string | null | undefined, nowMs: number = Date.now()): boolean {
  const created = createdAt ? Date.parse(createdAt) : Number.NaN;
  return Number.isFinite(created) && nowMs - created > STALE_PENDING_MS;
}

/**
 * True for a pending optimizer recommendation created more than 14 days ago.
 * A row with no readable timestamp is NOT stale: nothing proves its age, so it
 * keeps its current behavior.
 */
export function isStalePendingRecommendation(
  row: StalenessCandidate | null | undefined,
  nowMs: number = Date.now()
): boolean {
  if (!row || row.status !== 'pending') return false;
  if (!isOptimizerRecommendation(row)) return false;
  return isPastStaleLine(row.created_at, nowMs);
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
