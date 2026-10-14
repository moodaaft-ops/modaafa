import { DEFAULT_STEP_EXPIRY_MINUTES, type Step } from '@/config/email-journeys';
import type { UserEventType } from '@/lib/stages/types';
import type { JourneyId } from '@/lib/lifecycle/types';

/**
 * Which journey a user is in right now. Pure: no database, no clock.
 *
 * Journeys are DERIVED at planning time from the funnel stage, the latest
 * subscription and the funnel events. There is no stored journey and no new
 * stage or event name (contract decision 2), so a user can never be "stuck" in
 * a journey the data no longer supports.
 */
export type JourneySubscription = {
  status: string | null;
  createdAt: string | null;
  trialEndsAt: string | null;
  canceledAt: string | null;
  lastEventAt: string | null;
};

export type JourneyEvents = Partial<Record<UserEventType, string>>;

export type JourneyInput = {
  /** users.stage (null while a registration is unfinished). */
  stage: string | null;
  /** The LATEST subscription row, or null when the user never had one. */
  subscription: JourneySubscription | null;
  events: JourneyEvents;
};

export type JourneyEntry = { journey: JourneyId; enteredAt: string };

function toIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function entry(journey: JourneyId, enteredAt: string | null | undefined): JourneyEntry | null {
  const iso = toIso(enteredAt);
  return iso ? { journey, enteredAt: iso } : null;
}

/**
 * Rules, in priority order:
 *   1. latest subscription past_due          -> past_due (entered at last_event_at, else created_at)
 *   2. trialing                              -> trial (entered at subscription created_at)
 *   3. active                                -> none (the weekly report covers them)
 *   4. paused                                -> none
 *   5. canceled: ever paid                   -> canceled (entered at canceled_at)
 *                never paid                  -> trial_lapsed (canceled_at, else trial_ends_at)
 *   6. no subscription: stage registered     -> registered      (registration_completed)
 *                       stage connected      -> connected       (ads_account_connected)
 *                       stage analysis_viewed-> plan_ready      (first_analysis_viewed)
 *
 * A subscription row with an unknown status gives no journey: silence is the
 * safe answer when the data cannot be read.
 */
export function currentJourney(input: JourneyInput): JourneyEntry | null {
  const subscription = input.subscription;
  if (subscription) {
    switch (subscription.status) {
      case 'past_due':
        // subscriptions has no updated_at column; created_at is the only other anchor.
        return entry('past_due', subscription.lastEventAt ?? subscription.createdAt);
      case 'trialing':
        return entry('trial', subscription.createdAt);
      case 'canceled':
        return input.events.subscription_paid
          ? entry('canceled', subscription.canceledAt)
          : entry('trial_lapsed', subscription.canceledAt ?? subscription.trialEndsAt);
      case 'active':
      case 'paused':
      default:
        return null;
    }
  }

  switch (input.stage) {
    case 'registered':
      return entry('registered', input.events.registration_completed);
    case 'connected':
      return entry('connected', input.events.ads_account_connected);
    case 'analysis_viewed':
      return entry('plan_ready', input.events.first_analysis_viewed);
    default:
      return null;
  }
}

export function stepExpiryMinutes(step: Step): number {
  return step.expiresAfterMinutes ?? DEFAULT_STEP_EXPIRY_MINUTES;
}

/** Latest moment (minutes after entry) at which any step of the journey can still go out. */
export function journeyHorizonMinutes(steps: Step[]): number {
  return steps.reduce((max, step) => Math.max(max, step.afterMinutes + stepExpiryMinutes(step)), 0);
}

export function journeyLastStepMinutes(steps: Step[]): number {
  return steps.reduce((max, step) => Math.max(max, step.afterMinutes), 0);
}
