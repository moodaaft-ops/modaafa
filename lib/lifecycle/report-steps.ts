import type { CopyKey, JourneyId } from './types';

/**
 * What the email section of the funnel report needs to know about the journeys:
 * which template belongs to which journey, how long after entering the journey
 * it is due, when the lifecycle went live and how big the holdout is.
 *
 * This is a MIRROR of config/email-journeys.ts (JOURNEY_STEPS,
 * EMAIL_LIFECYCLE_ACTIVATED_AT, HOLDOUT_PERCENT), kept here so the report
 * compiles and is tested on its own. Once the engine's config is merged, replace
 * the three exports below with
 *
 *   export const REPORT_STEPS = flattenSteps(JOURNEY_STEPS);
 *   export const REPORT_ACTIVATED_AT = EMAIL_LIFECYCLE_ACTIVATED_AT;
 *   export const REPORT_HOLDOUT_PERCENT = HOLDOUT_PERCENT;
 *
 * (flattenSteps is the 3-line function at the bottom of this file). Nothing
 * else in the report changes. tests/email-report.test.ts has a guard that fails
 * when the mirror and the config disagree, once the config exists.
 */
export type ReportStep = { copyKey: CopyKey; journey: JourneyId; afterMinutes: number };

const MINUTES_PER_DAY = 24 * 60;

export const REPORT_STEPS: ReportStep[] = [
  { journey: 'registered', copyKey: 'registered_1d', afterMinutes: MINUTES_PER_DAY },
  { journey: 'registered', copyKey: 'registered_3d', afterMinutes: 3 * MINUTES_PER_DAY },
  { journey: 'registered', copyKey: 'registered_7d', afterMinutes: 7 * MINUTES_PER_DAY },
  { journey: 'connected', copyKey: 'connected_3h', afterMinutes: 180 },
  { journey: 'connected', copyKey: 'connected_1d', afterMinutes: MINUTES_PER_DAY },
  { journey: 'plan_ready', copyKey: 'plan_ready_1d', afterMinutes: MINUTES_PER_DAY },
  { journey: 'plan_ready', copyKey: 'plan_ready_3d', afterMinutes: 3 * MINUTES_PER_DAY },
  { journey: 'plan_ready', copyKey: 'plan_ready_7d', afterMinutes: 7 * MINUTES_PER_DAY },
  { journey: 'trial', copyKey: 'trial_d1', afterMinutes: MINUTES_PER_DAY },
  { journey: 'trial', copyKey: 'trial_d4', afterMinutes: 4 * MINUTES_PER_DAY },
  { journey: 'trial', copyKey: 'trial_d9', afterMinutes: 9 * MINUTES_PER_DAY },
  { journey: 'trial_lapsed', copyKey: 'trial_lapsed_2d', afterMinutes: 2 * MINUTES_PER_DAY },
  { journey: 'trial_lapsed', copyKey: 'trial_lapsed_14d', afterMinutes: 14 * MINUTES_PER_DAY },
  { journey: 'canceled', copyKey: 'canceled_1d', afterMinutes: MINUTES_PER_DAY },
  { journey: 'canceled', copyKey: 'canceled_30d', afterMinutes: 30 * MINUTES_PER_DAY },
  { journey: 'past_due', copyKey: 'past_due_3d', afterMinutes: 3 * MINUTES_PER_DAY },
];

/** The moment the lifecycle goes live (ISO). null = it has not, so no holdout comparison exists yet. */
export const REPORT_ACTIVATED_AT: string | null = null;

export const REPORT_HOLDOUT_PERCENT = 10;

export function flattenSteps(
  journeys: Record<JourneyId, Array<{ copyKey: CopyKey; afterMinutes: number }>>
): ReportStep[] {
  return (Object.keys(journeys) as JourneyId[]).flatMap((journey) =>
    journeys[journey].map((step) => ({ journey, copyKey: step.copyKey, afterMinutes: step.afterMinutes }))
  );
}
