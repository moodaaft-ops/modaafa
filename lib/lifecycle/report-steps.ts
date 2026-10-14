import type { CopyKey, JourneyId } from './types';
import { EMAIL_LIFECYCLE_ACTIVATED_AT, HOLDOUT_PERCENT, JOURNEY_STEPS } from '@/config/email-journeys';

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

export const REPORT_STEPS: ReportStep[] = flattenSteps(JOURNEY_STEPS);

/** The moment the lifecycle goes live (ISO). null = it has not, so no holdout comparison exists yet. */
export const REPORT_ACTIVATED_AT: string | null = EMAIL_LIFECYCLE_ACTIVATED_AT;

export const REPORT_HOLDOUT_PERCENT = HOLDOUT_PERCENT;

export function flattenSteps(
  journeys: Record<JourneyId, Array<{ copyKey: CopyKey; afterMinutes: number }>>
): ReportStep[] {
  return (Object.keys(journeys) as JourneyId[]).flatMap((journey) =>
    journeys[journey].map((step) => ({ journey, copyKey: step.copyKey, afterMinutes: step.afterMinutes }))
  );
}
