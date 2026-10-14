import type { CopyKey, JourneyId } from '@/lib/lifecycle/types';

/**
 * The email lifecycle schedule. This is the one file to edit to change a
 * timing, a limit or the activation moment. It replaces config/stage-followups.ts.
 *
 * Reading guide
 *   - `afterMinutes` is counted from the moment the user ENTERED the journey
 *     (see lib/lifecycle/journey.ts for what "entering" means per journey).
 *   - Steps run in order. If several are overdue at once (the scheduler was
 *     off for a day), only the latest one is sent and the older ones are
 *     recorded as skipped (`superseded`). Nobody receives three emails in a row.
 *   - A step that is more than its expiry past due is recorded as skipped
 *     (`expired`) instead of arriving days late.
 *   - When the user moves to another journey (connects, subscribes, cancels)
 *     the old journey's remaining steps stop on their own: only the CURRENT
 *     journey's steps are ever read.
 *
 * Nothing is sent until ALL of these are true:
 *   1. EMAIL_LIFECYCLE_ENABLED=true in the environment
 *   2. EMAIL_LIFECYCLE_ACTIVATED_AT below is a real ISO date (a step whose due
 *      time is before it is never sent, so the existing user base is not
 *      mailed retroactively; null means nobody)
 *   3. the copy is `approved: true` in lib/lifecycle/copy.ts
 */
export type Step = {
  copyKey: CopyKey;
  afterMinutes: number;
  /** Minutes after the due time during which the step may still go out. Default: 48 hours. */
  expiresAfterMinutes?: number;
};

const day = (n: number) => n * 24 * 60;

export const DEFAULT_STEP_EXPIRY_MINUTES = day(2);

export const JOURNEY_STEPS: Record<JourneyId, Step[]> = {
  registered: [
    { copyKey: 'registered_1d', afterMinutes: 1440 },
    { copyKey: 'registered_3d', afterMinutes: 4320 },
    { copyKey: 'registered_7d', afterMinutes: 10080 },
  ],
  connected: [
    { copyKey: 'connected_3h', afterMinutes: 180 },
    { copyKey: 'connected_1d', afterMinutes: 1440 },
  ],
  plan_ready: [
    { copyKey: 'plan_ready_1d', afterMinutes: 1440 },
    { copyKey: 'plan_ready_3d', afterMinutes: 4320 },
    { copyKey: 'plan_ready_7d', afterMinutes: 10080 },
  ],
  trial: [
    { copyKey: 'trial_d1', afterMinutes: 1440 },
    { copyKey: 'trial_d4', afterMinutes: 5760 },
    { copyKey: 'trial_d9', afterMinutes: 12960 },
  ],
  trial_lapsed: [
    { copyKey: 'trial_lapsed_2d', afterMinutes: 2880 },
    { copyKey: 'trial_lapsed_14d', afterMinutes: 20160, expiresAfterMinutes: day(7) },
  ],
  canceled: [
    { copyKey: 'canceled_1d', afterMinutes: 1440 },
    { copyKey: 'canceled_30d', afterMinutes: 43200, expiresAfterMinutes: day(7) },
  ],
  past_due: [{ copyKey: 'past_due_3d', afterMinutes: 4320 }],
};

/**
 * The moment the lifecycle goes live (ISO, with offset). A step whose due time
 * is earlier than this is never sent, whatever else is true. null = nobody.
 */
export const EMAIL_LIFECYCLE_ACTIVATED_AT: string | null = null;

/** Percent of users (stable, by hash of the user id) who receive no journey mail. See lib/lifecycle/holdout.ts. */
export const HOLDOUT_PERCENT = 10;

/**
 * Optional mail goes out only when the local hour is in [startHour, endHour).
 * Riyadh is UTC+3 all year with no daylight saving; lib/lifecycle/riyadh.ts
 * does the arithmetic with a fixed offset.
 */
export type SendWindow = { tz: 'Asia/Riyadh'; startHour: number; endHour: number };
export const SEND_WINDOW: SendWindow = { tz: 'Asia/Riyadh', startHour: 9, endHour: 22 };

/** At most one non-transactional mail to the same person inside this window. */
export const MIN_GAP_MS = 24 * 60 * 60 * 1000;
/** ...and at most this many in any rolling 7 days. Transactional mail never counts. */
export const MAX_PER_7_DAYS = 3;

/** Hard ceiling on one run, so a mistake in the config cannot mail everyone at once. */
export const MAX_SENDS_PER_RUN = 100;
/** How many broadcast mails one run may add, so a list goes out gradually. */
export const BROADCAST_BATCH_PER_RUN = 40;

/** A failed send is retried on later runs up to this many attempts in total (claim_message enforces the same number). */
export const MAX_SEND_ATTEMPTS = 3;

/**
 * Weekly report: every Sunday 09:00 Riyadh, sendable for `windowHours` after
 * that. `weekday` follows Date#getUTCDay (0 = Sunday).
 */
export type WeeklyReportConfig = { weekday: number; hour: number; windowHours: number };
export const WEEKLY_REPORT: WeeklyReportConfig = { weekday: 0, hour: 9, windowHours: 60 };
