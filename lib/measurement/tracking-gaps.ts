import { addDays } from '@/lib/jarvis/tools/shared';

/**
 * Finds a past stretch in which conversions went to zero while clicks kept
 * coming, then resumed. That is the window a bidding data exclusion is for.
 * Pure rules, no model. An ongoing silence is NOT proposed here: the tracking
 * verdict already says "broken, fix it", and excluding days before the fix
 * would only hide the damage.
 */
export const GAP_MIN_DAYS = 3;
export const GAP_MAX_DAYS = 14;
/** Every day of the gap must have had at least this many clicks (traffic really flowed). */
export const GAP_MIN_CLICKS_PER_DAY = 20;
/**
 * A zero run only counts as a break when the conversions that should have come
 * in that window (baseline per day x days) are at least this many. At 8 the
 * chance of the run being pure luck is below 0.1% (e^-8), so a slow account
 * needs a longer silence before we call it broken and a busy one needs 3 days.
 */
export const GAP_MIN_EXPECTED_MISSING = 8;

export type DailyTotal = { date: string; conversions: number; clicks: number };

export type TrackingGap = {
  start: string;
  end: string;
  days: number;
  baselinePerDay: number;
};

export type TrackingGapResult = {
  gaps: TrackingGap[];
  /** Conversions are still silent through yesterday: tracking is broken now, nothing to exclude yet. */
  ongoing: boolean;
};

/** Daily totals for the last `windowDays` days ending yesterday, filling missing days with zero. */
export function totalsByDay(
  conversions: Array<{ date: string; conversions: number }>,
  clicks: Array<{ date: string; clicks: number }>,
  today: string,
  windowDays = 30
): DailyTotal[] {
  const conv = new Map<string, number>();
  for (const row of conversions) conv.set(row.date, (conv.get(row.date) ?? 0) + (Number(row.conversions) || 0));
  const click = new Map<string, number>();
  for (const row of clicks) click.set(row.date, (click.get(row.date) ?? 0) + (Number(row.clicks) || 0));
  const out: DailyTotal[] = [];
  for (let offset = windowDays; offset >= 1; offset -= 1) {
    const date = addDays(today, -offset);
    out.push({ date, conversions: conv.get(date) ?? 0, clicks: click.get(date) ?? 0 });
  }
  return out;
}

export function findTrackingGaps(days: DailyTotal[]): TrackingGapResult {
  const gaps: TrackingGap[] = [];
  let ongoing = false;
  let i = 0;
  while (i < days.length) {
    if (days[i].conversions > 0) {
      i += 1;
      continue;
    }
    let j = i;
    while (j + 1 < days.length && days[j + 1].conversions <= 0) j += 1;
    const run = days.slice(i, j + 1);
    const length = run.length;
    const trafficFlowed = run.every((day) => day.clicks >= GAP_MIN_CLICKS_PER_DAY);
    const reachesYesterday = j === days.length - 1;
    const hadConversionsBefore = days.slice(0, i).some((day) => day.conversions > 0);

    if (trafficFlowed && length >= GAP_MIN_DAYS && hadConversionsBefore) {
      const outside = days.filter((_, index) => index < i || index > j);
      const baseline = outside.reduce((sum, day) => sum + day.conversions, 0) / Math.max(outside.length, 1);
      if (baseline * length >= GAP_MIN_EXPECTED_MISSING) {
        if (reachesYesterday) ongoing = true;
        else if (length <= GAP_MAX_DAYS) {
          gaps.push({
            start: run[0].date,
            end: run[run.length - 1].date,
            days: length,
            baselinePerDay: Math.round(baseline * 10) / 10,
          });
        }
      }
    }
    i = j + 1;
  }
  return { gaps, ongoing };
}
