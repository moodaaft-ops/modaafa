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
 */
export function optimizerCooldownCutoffIso(nowMs: number, hours: number): string | null {
  if (!Number.isFinite(hours) || hours <= 0) return null;
  if (!Number.isFinite(nowMs)) return null;
  return new Date(nowMs - hours * HOUR_MS).toISOString();
}

function metric(row: any, camel: string, snake: string) {
  const metrics = row?.metrics ?? {};
  const value = Number(metrics[camel] ?? metrics[snake] ?? 0);
  return Number.isFinite(value) ? value : 0;
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
