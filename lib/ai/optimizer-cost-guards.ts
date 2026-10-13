import type { OptimizerSnapshot } from './optimizer-agent';

/**
 * Two cost guards for the nightly optimizer. Both are pure so they can be
 * tested without a database or a model call.
 */

const HOUR_MS = 60 * 60 * 1000;

/**
 * ISO instant before which an account counts as "recently optimized". Returns
 * null when the cooldown is off (hours <= 0 or not a number), so callers can
 * skip the filter entirely.
 *
 * A small grace (30 minutes, or a tenth of a short cooldown) is taken off,
 * because the cursor is stamped when an account finishes, up to a few minutes
 * after its run started, while the next run measures from its own start. Without
 * the grace, two slots exactly 12 hours apart would miss each other and the
 * account would wait for the slot after.
 */
export function optimizerCooldownCutoffIso(nowMs: number, hours: number): string | null {
  if (!Number.isFinite(hours) || hours <= 0) return null;
  if (!Number.isFinite(nowMs)) return null;
  const graceMs = Math.min(30 * 60 * 1000, hours * HOUR_MS * 0.1);
  return new Date(nowMs - (hours * HOUR_MS - graceMs)).toISOString();
}

/**
 * Value written to google_ads_accounts.last_optimized_at when an account's pass
 * ends. A pass that finished stamps "now" and the account rests for the whole
 * cooldown. A pass that failed (Anthropic out of credit, a Google quota error)
 * must NOT lock the account out for hours after the cause is fixed, so it is
 * stamped as if it had been optimized (cooldown - retryAfterHours) ago: it still
 * goes to the back of the round-robin queue, and becomes eligible again about
 * retryAfterHours later.
 */
export function optimizerCursorStampIso(
  nowMs: number,
  cooldownHours: number,
  failed: boolean,
  retryAfterHours = 1
): string {
  if (!failed || !Number.isFinite(cooldownHours) || cooldownHours <= retryAfterHours) {
    return new Date(nowMs).toISOString();
  }
  return new Date(nowMs - (cooldownHours - retryAfterHours) * HOUR_MS).toISOString();
}

/**
 * A metric that is missing counts as 0, but one that is present and not a
 * number counts as "a lot": a row we cannot read must never make an account
 * look idle.
 */
function metric(row: any, camel: string, snake: string) {
  const metrics = row?.metrics ?? {};
  const raw = metrics[camel] ?? metrics[snake];
  if (raw === undefined || raw === null || raw === '') return 0;
  const value = Number(raw);
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

function hasActivity(row: any) {
  return (
    metric(row, 'costMicros', 'cost_micros') > 0 ||
    metric(row, 'clicks', 'clicks') > 0 ||
    metric(row, 'conversions', 'conversions') > 0
  );
}

/**
 * True when the snapshot holds nothing the model could act on, so asking it
 * would only buy the sentence "no action". Deliberately narrow: every action
 * the prompt allows needs either an evidence row (a keyword, search term or ad
 * to touch) or real spend in the last 7 days (a budget or bid to move), and an
 * account with none of those returns an empty list anyway.
 *
 * Anything doubtful counts as NOT idle, so the model is still asked.
 */
export function isSnapshotIdle(
  snapshot: Pick<
    OptimizerSnapshot,
    | 'campaigns'
    | 'underperforming_keywords'
    | 'wasted_search_terms'
    | 'converting_search_terms'
    | 'poor_ads'
    | 'ad_group_bid_targets'
  >
): boolean {
  const evidenceLists = [
    snapshot.underperforming_keywords,
    snapshot.wasted_search_terms,
    snapshot.converting_search_terms,
    snapshot.poor_ads,
  ];
  for (const list of evidenceLists) {
    if (!Array.isArray(list)) return false;
    if (list.length > 0) return false;
  }
  if (!Array.isArray(snapshot.campaigns)) return false;
  if (snapshot.campaigns.some(hasActivity)) return false;
  // A bid target that carried spend or conversions in its 30 day window is
  // something adjust_bid could still anchor to.
  if ((snapshot.ad_group_bid_targets ?? []).some(hasActivity)) return false;
  return true;
}
