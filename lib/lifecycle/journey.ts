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
  /**
   * Stripe's `canceled_at`: the moment the cancellation was REQUESTED. An in-app
   * cancel is `cancel_at_period_end`, so this can be days or months before the
   * subscription actually ended. Never use it alone as "when it became canceled".
   */
  canceledAt: string | null;
  /**
   * The newest Stripe event applied to the row. It is stamped by the event that
   * wrote status `canceled`, so for a canceled row it is the moment the
   * subscription really ended. A past_due row has it bumped by every retry.
   */
  lastEventAt: string | null;
  /** Start of the billing period the row is in; for past_due, the unpaid period. Does not move on a retry. */
  currentPeriodStart: string | null;
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
 * A trial that was cancelled before it could end is not a lapse. The Stripe
 * webhook (lib/billing/stripe-webhook-handler.ts) and checkout/complete write a
 * trial that is refused for a reused card or Google Ads account as `canceled`
 * the moment it starts, while `trial_ends_at` is still days away. Nothing else
 * is stored about why (billing_trial_grants and the ledgers count a blocked
 * trial as used, so they cannot tell it apart), which makes this the signal: the
 * event that wrote `canceled` is dated BEFORE the trial's own end. A real lapse
 * (cancel at period end, failed first charge) is written at or after the trial
 * end. The same shape also covers a trial that support cut short in the
 * dashboard; staying silent for them is the safe side. A row with no
 * last_event_at cannot be judged and is treated as a lapse.
 */
export const TRIAL_CUT_SHORT_TOLERANCE_MS = 60 * 60 * 1000;

function trialCutShort(subscription: JourneySubscription): boolean {
  const flipped = Date.parse(subscription.lastEventAt ?? '');
  const trialEnd = Date.parse(subscription.trialEndsAt ?? '');
  return Number.isFinite(flipped) && Number.isFinite(trialEnd) && flipped < trialEnd - TRIAL_CUT_SHORT_TOLERANCE_MS;
}

/** The latest of the parseable timestamps, as the original string, or null. */
function latestOf(...values: Array<string | null>): string | null {
  let best: string | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const ms = Date.parse(value ?? '');
    if (Number.isFinite(ms) && ms > bestMs) {
      best = value;
      bestMs = ms;
    }
  }
  return best;
}

/**
 * The moment the subscription actually became canceled: the event that wrote
 * the status (`last_event_at`), never Stripe's `canceled_at`, which is when the
 * cancellation was requested. Without an event time, the later of the request
 * and (for a trial) the trial end.
 */
function becameCanceledAt(subscription: JourneySubscription, viaTrialEnd: boolean): string | null {
  if (Number.isFinite(Date.parse(subscription.lastEventAt ?? ''))) return subscription.lastEventAt;
  return viaTrialEnd ? latestOf(subscription.canceledAt, subscription.trialEndsAt) : subscription.canceledAt;
}

/**
 * Rules, in priority order:
 *   1. latest subscription past_due          -> past_due (entered at current_period_start, else
 *                                               last_event_at, else created_at; a retry never moves it)
 *   2. trialing                              -> trial (entered at subscription created_at)
 *   3. active                                -> none (the weekly report covers them)
 *   4. paused                                -> none
 *   5. canceled: ever paid                   -> canceled (entered when it became canceled:
 *                                               last_event_at, else canceled_at)
 *                never paid                  -> trial_lapsed (entered when it became canceled:
 *                                               last_event_at, else max(canceled_at, trial_ends_at)),
 *                                               unless the trial was cut short, see trialCutShort: then none
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
        // Stripe retries a failed card for days and every retry bumps last_event_at, so that would drift
        // the anchor forward. The unpaid period's start does not move (it is also what the access grace
        // in lib/billing/entitlements.ts is counted from). subscriptions has no updated_at column.
        return entry('past_due', subscription.currentPeriodStart ?? subscription.lastEventAt ?? subscription.createdAt);
      case 'trialing':
        return entry('trial', subscription.createdAt);
      case 'canceled':
        if (input.events.subscription_paid) return entry('canceled', becameCanceledAt(subscription, false));
        // A trial refused at its start (reused card or ads account) never was a trial: no "your trial ended".
        if (trialCutShort(subscription)) return null;
        return entry('trial_lapsed', becameCanceledAt(subscription, true));
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
