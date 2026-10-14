/**
 * What the optimize cron leaves behind for whoever audits a run.
 *
 * `job_runs.details` already carried the totals (queued, blocked, executed).
 * It could not say WHY an account got no budget change: was the conversion
 * tracking unhealthy, were the economics unknown, was the budget locked, or was
 * it a duplicate of a card already waiting? These small tallies answer that
 * from one JSON read, with no new column. They hold counts only, never a
 * campaign name, a keyword or an amount.
 */

export const TRACKING_VERDICTS = [
  'healthy',
  'suspect',
  'missing',
  'wrong_primary',
  'broken_recently',
  'unknown',
] as const;

export type TrackingVerdict = (typeof TRACKING_VERDICTS)[number];

/** How many accounts of the run ended up with each conversion tracking verdict. */
export type TrackingVerdictCounts = Record<TrackingVerdict, number>;

export function emptyTrackingVerdictCounts(): TrackingVerdictCounts {
  return { healthy: 0, suspect: 0, missing: 0, wrong_primary: 0, broken_recently: 0, unknown: 0 };
}

/** Count one account's verdict. A value that is not a known verdict (or no verdict at all) is «unknown». */
export function tallyTrackingVerdict(counts: TrackingVerdictCounts, status: unknown): TrackingVerdict {
  const verdict = (TRACKING_VERDICTS as readonly string[]).includes(String(status))
    ? (String(status) as TrackingVerdict)
    : 'unknown';
  counts[verdict] += 1;
  return verdict;
}

/** A count of refusals, by the reason code and by the kind of action. */
export type ReasonTally = {
  total: number;
  by_reason: Record<string, number>;
  by_action: Record<string, number>;
};

export function emptyReasonTally(): ReasonTally {
  return { total: 0, by_reason: {}, by_action: {} };
}

function bump(map: Record<string, number>, key: string) {
  map[key] = (map[key] ?? 0) + 1;
}

/** Count one refusal. The reason and the action type are short codes, capped so a bad value cannot bloat the row. */
export function tallyReason(tally: ReasonTally, input: { code: string; action_type?: string | null }): void {
  const code = String(input.code || 'unspecified').slice(0, 64);
  const actionType = String(input.action_type || 'unknown').slice(0, 64);
  tally.total += 1;
  bump(tally.by_reason, code);
  bump(tally.by_action, actionType);
}
