import type { UserStage } from '@/lib/stages/types';

/**
 * Follow-up schedule per stage. This is the one file to edit to change a timing.
 *
 * Reading guide
 *   - `afterMinutes` is counted from the moment the user ENTERED the stage
 *     (registration, ads_account_connected, first_analysis_viewed).
 *   - Steps run in order. If several are overdue at once (for example the
 *     scheduler was off for a day), only the latest one is sent and the older
 *     ones are marked skipped. Nobody receives three emails in a row.
 *   - When the user moves to a later stage, the old stage's remaining steps
 *     stop on their own: only the CURRENT stage's steps are ever considered.
 *   - `registered` stops after the last step. There is no fourth reminder.
 *
 * Nothing is sent until ALL of these are true:
 *   1. STAGE_FOLLOWUPS_ENABLED=true in the environment
 *   2. `cohortStart` below is a real date (everyone who registered before it
 *      receives nothing, ever; null means nobody is eligible)
 *   3. the step's `approved` is true (texts live in lib/stages/messages.ts and
 *      are drafts until Ayman has read them)
 */
export type FollowupStep = {
  /** Stable key stored in message_log. Never reuse a key for different text. */
  key: string;
  afterMinutes: number;
  /** Flip to true only after the text in lib/stages/messages.ts is approved. */
  approved: boolean;
};

export const STAGE_FOLLOWUP_STEPS: Partial<Record<UserStage, FollowupStep[]>> = {
  registered: [
    { key: 'registered_1h', afterMinutes: 60, approved: false },
    { key: 'registered_1d', afterMinutes: 24 * 60, approved: false },
    { key: 'registered_3d', afterMinutes: 3 * 24 * 60, approved: false },
  ],
  connected: [
    { key: 'connected_15m', afterMinutes: 15, approved: false },
    { key: 'connected_1d', afterMinutes: 24 * 60, approved: false },
  ],
  analysis_viewed: [
    { key: 'analysis_viewed_1d', afterMinutes: 24 * 60, approved: false },
    { key: 'analysis_viewed_3d', afterMinutes: 3 * 24 * 60, approved: false },
  ],
};

/**
 * Only users who registered at or after this moment can ever be messaged.
 * Set it to the activation time (ISO, with offset) when switching the feature
 * on, so the whole existing user base is excluded. null = nobody.
 */
export const STAGE_FOLLOWUPS_COHORT_START: string | null = null;

/** At most one message to the same person inside this window. */
export const MIN_GAP_BETWEEN_MESSAGES_MS = 24 * 60 * 60 * 1000;

/** A failed send is retried on later runs up to this many attempts in total. */
export const MAX_SEND_ATTEMPTS = 3;
