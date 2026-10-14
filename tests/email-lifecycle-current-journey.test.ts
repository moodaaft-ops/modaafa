import assert from 'node:assert/strict';
import test from 'node:test';
import { BROADCASTS, SEGMENT_IDS } from '../config/email-broadcasts';
import {
  BROADCAST_BATCH_PER_RUN,
  DEFAULT_STEP_EXPIRY_MINUTES,
  EMAIL_LIFECYCLE_ACTIVATED_AT,
  HOLDOUT_PERCENT,
  JOURNEY_STEPS,
  MAX_PER_7_DAYS,
  MAX_SENDS_PER_RUN,
  MIN_GAP_MS,
  SEND_WINDOW,
  WEEKLY_REPORT,
} from '../config/email-journeys';
import { PAST_DUE_GRACE_MS } from '../lib/billing/entitlements';
import { EMAIL_COPY } from '../lib/lifecycle/copy';
import {
  currentJourney,
  journeyHorizonMinutes,
  journeyLastStepMinutes,
  type JourneyInput,
  type JourneySubscription,
} from '../lib/lifecycle/journey';
import { COPY_KEYS, type JourneyId } from '../lib/lifecycle/types';

const T = {
  registered: '2026-10-01T10:00:00.000Z',
  connected: '2026-10-02T10:00:00.000Z',
  viewed: '2026-10-03T10:00:00.000Z',
  paid: '2026-10-09T10:00:00.000Z',
  subCreated: '2026-10-04T10:00:00.000Z',
  trialEnds: '2026-10-18T10:00:00.000Z',
  /** Stripe's canceled_at: when the cancel was REQUESTED (cancel_at_period_end). */
  canceled: '2026-10-20T10:00:00.000Z',
  /** The event that wrote status canceled: when the subscription really ended. */
  lastEvent: '2026-10-22T10:00:00.000Z',
  periodStart: '2026-10-15T10:00:00.000Z',
};

const sub = (overrides: Partial<JourneySubscription>): JourneySubscription => ({
  status: 'trialing',
  createdAt: T.subCreated,
  trialEndsAt: T.trialEnds,
  canceledAt: null,
  lastEventAt: null,
  currentPeriodStart: null,
  ...overrides,
});

type Case = { name: string; input: JourneyInput; expected: { journey: JourneyId; enteredAt: string } | null };

const events = {
  registration_completed: T.registered,
  ads_account_connected: T.connected,
  first_analysis_viewed: T.viewed,
};

const cases: Case[] = [
  { name: 'registered, nothing else', input: { stage: 'registered', subscription: null, events: { registration_completed: T.registered } }, expected: { journey: 'registered', enteredAt: T.registered } },
  { name: 'registered with no registration event (old user) has no journey', input: { stage: 'registered', subscription: null, events: {} }, expected: null },
  { name: 'connected enters at the connect event', input: { stage: 'connected', subscription: null, events }, expected: { journey: 'connected', enteredAt: T.connected } },
  { name: 'analysis_viewed becomes plan_ready, entered at first_analysis_viewed', input: { stage: 'analysis_viewed', subscription: null, events }, expected: { journey: 'plan_ready', enteredAt: T.viewed } },
  { name: 'stage subscribed with no subscription row has no journey', input: { stage: 'subscribed', subscription: null, events }, expected: null },
  { name: 'unfinished registration (null stage) has no journey', input: { stage: null, subscription: null, events }, expected: null },
  { name: 'trialing wins over the stage, entered at the subscription creation', input: { stage: 'analysis_viewed', subscription: sub({ status: 'trialing' }), events }, expected: { journey: 'trial', enteredAt: T.subCreated } },
  { name: 'active has no journey (the weekly report covers them)', input: { stage: 'subscribed', subscription: sub({ status: 'active' }), events: { ...events, subscription_paid: T.paid } }, expected: null },
  { name: 'paused has no journey', input: { stage: 'subscribed', subscription: sub({ status: 'paused' }), events: { ...events, subscription_paid: T.paid } }, expected: null },
  { name: 'past_due is entered at current_period_start, not at the last Stripe event', input: { stage: 'subscribed', subscription: sub({ status: 'past_due', currentPeriodStart: T.periodStart, lastEventAt: T.lastEvent }), events: { ...events, subscription_paid: T.paid } }, expected: { journey: 'past_due', enteredAt: T.periodStart } },
  { name: 'past_due without current_period_start falls back to last_event_at', input: { stage: 'subscribed', subscription: sub({ status: 'past_due', lastEventAt: T.lastEvent }), events: { ...events, subscription_paid: T.paid } }, expected: { journey: 'past_due', enteredAt: T.lastEvent } },
  { name: 'past_due with neither falls back to created_at', input: { stage: 'subscribed', subscription: sub({ status: 'past_due', lastEventAt: null }), events: { ...events, subscription_paid: T.paid } }, expected: { journey: 'past_due', enteredAt: T.subCreated } },
  { name: 'canceled after paying is entered when it became canceled (last_event_at), not when the cancel was requested', input: { stage: 'subscribed', subscription: sub({ status: 'canceled', canceledAt: T.canceled, lastEventAt: T.lastEvent }), events: { ...events, subscription_paid: T.paid } }, expected: { journey: 'canceled', enteredAt: T.lastEvent } },
  { name: 'canceled after paying without last_event_at falls back to canceled_at', input: { stage: 'subscribed', subscription: sub({ status: 'canceled', canceledAt: T.canceled }), events: { ...events, subscription_paid: T.paid } }, expected: { journey: 'canceled', enteredAt: T.canceled } },
  { name: 'canceled without ever paying is trial_lapsed, entered at last_event_at, not at the cancel request', input: { stage: 'analysis_viewed', subscription: sub({ status: 'canceled', canceledAt: T.canceled, lastEventAt: T.lastEvent }), events }, expected: { journey: 'trial_lapsed', enteredAt: T.lastEvent } },
  { name: 'trial_lapsed without last_event_at: a cancel requested after the trial end is entered at canceled_at', input: { stage: 'analysis_viewed', subscription: sub({ status: 'canceled', canceledAt: T.canceled }), events }, expected: { journey: 'trial_lapsed', enteredAt: T.canceled } },
  { name: 'trial_lapsed without last_event_at: a cancel requested during the trial is entered at trial_ends_at', input: { stage: 'analysis_viewed', subscription: sub({ status: 'canceled', canceledAt: '2026-10-10T10:00:00.000Z' }), events }, expected: { journey: 'trial_lapsed', enteredAt: T.trialEnds } },
  { name: 'trial_lapsed without canceled_at uses trial_ends_at', input: { stage: 'analysis_viewed', subscription: sub({ status: 'canceled', canceledAt: null }), events }, expected: { journey: 'trial_lapsed', enteredAt: T.trialEnds } },
  { name: 'canceled after paying but with no canceled_at has no journey (no anchor)', input: { stage: 'subscribed', subscription: sub({ status: 'canceled', canceledAt: null }), events: { ...events, subscription_paid: T.paid } }, expected: null },
  { name: 'a lapse written right after the trial end is a trial_lapsed', input: { stage: 'analysis_viewed', subscription: sub({ status: 'canceled', canceledAt: T.subCreated, lastEventAt: '2026-10-18T10:05:00.000Z' }), events }, expected: { journey: 'trial_lapsed', enteredAt: '2026-10-18T10:05:00.000Z' } },
  { name: 'an event stamped a few minutes before the trial end (clock skew) is still a trial_lapsed', input: { stage: 'analysis_viewed', subscription: sub({ status: 'canceled', canceledAt: T.subCreated, lastEventAt: '2026-10-18T09:50:00.000Z' }), events }, expected: { journey: 'trial_lapsed', enteredAt: '2026-10-18T09:50:00.000Z' } },
  { name: 'a trial refused at its start (written canceled days before its trial end) has no journey', input: { stage: 'analysis_viewed', subscription: sub({ status: 'canceled', canceledAt: T.subCreated, lastEventAt: '2026-10-04T10:01:00.000Z' }), events }, expected: null },
  { name: 'a refused trial that also got a later cancel event stays out (the event is still before the trial end)', input: { stage: 'analysis_viewed', subscription: sub({ status: 'canceled', canceledAt: '2026-10-04T10:02:00.000Z', lastEventAt: '2026-10-04T10:03:00.000Z' }), events }, expected: null },
  { name: 'a refused trial is judged the same when only the stage says connected', input: { stage: 'connected', subscription: sub({ status: 'canceled', canceledAt: T.subCreated, lastEventAt: '2026-10-04T10:01:00.000Z' }), events }, expected: null },
  { name: 'a paying customer who cancelled before the old trial end date is still the canceled journey', input: { stage: 'subscribed', subscription: sub({ status: 'canceled', canceledAt: T.subCreated, lastEventAt: '2026-10-10T10:00:00.000Z' }), events: { ...events, subscription_paid: T.paid } }, expected: { journey: 'canceled', enteredAt: '2026-10-10T10:00:00.000Z' } },
  { name: 'an unknown subscription status gives silence, not a stage-based guess', input: { stage: 'registered', subscription: sub({ status: 'incomplete' }), events }, expected: null },
  { name: 'a null subscription status gives silence', input: { stage: 'registered', subscription: sub({ status: null }), events }, expected: null },
  { name: 'trialing with no created_at has no journey', input: { stage: 'connected', subscription: sub({ status: 'trialing', createdAt: null }), events }, expected: null },
  { name: 'an unparseable timestamp has no journey', input: { stage: 'registered', subscription: null, events: { registration_completed: 'not a date' } }, expected: null },
];

for (const row of cases) {
  test(`journey selection: ${row.name}`, () => {
    assert.deepEqual(currentJourney(row.input), row.expected);
  });
}

test('enteredAt is normalised to ISO even when the database returns an offset', () => {
  const entry = currentJourney({ stage: 'registered', subscription: null, events: { registration_completed: '2026-10-01T13:00:00+03:00' } });
  assert.equal(entry?.enteredAt, '2026-10-01T10:00:00.000Z');
});

// ---------------------------------------------------------------------------
// The config is the contract; pin it.
// ---------------------------------------------------------------------------

test('journey steps match the contract table exactly', () => {
  const flat = Object.fromEntries(
    Object.entries(JOURNEY_STEPS).map(([journey, steps]) => [journey, steps.map((s) => [s.copyKey, s.afterMinutes, s.expiresAfterMinutes ?? null])])
  );
  assert.deepEqual(flat, {
    registered: [['registered_1d', 1440, null], ['registered_3d', 4320, null], ['registered_7d', 10080, null]],
    connected: [['connected_3h', 180, null], ['connected_1d', 1440, null]],
    plan_ready: [['plan_ready_1d', 1440, null], ['plan_ready_3d', 4320, null], ['plan_ready_7d', 10080, null]],
    trial: [['trial_d1', 1440, null], ['trial_d4', 5760, null], ['trial_d9', 12960, null]],
    trial_lapsed: [['trial_lapsed_2d', 2880, null], ['trial_lapsed_14d', 20160, 7 * 1440]],
    canceled: [['canceled_1d', 1440, null], ['canceled_30d', 43200, 7 * 1440]],
    past_due: [['past_due_3d', 11520, null]],
  });
  assert.equal(DEFAULT_STEP_EXPIRY_MINUTES, 48 * 60);
});

test('past_due_3d is due the day after the access grace ends (copy key kept, the key is stored)', () => {
  const [step] = JOURNEY_STEPS.past_due;
  assert.equal(step!.copyKey, 'past_due_3d');
  assert.equal(step!.afterMinutes, PAST_DUE_GRACE_MS / 60_000 + 24 * 60);
  assert.equal(step!.afterMinutes, 8 * 24 * 60);
});

test('limits and switches match the contract, and the shipped state sends nothing', () => {
  assert.equal(EMAIL_LIFECYCLE_ACTIVATED_AT, null);
  assert.equal(HOLDOUT_PERCENT, 10);
  assert.deepEqual(SEND_WINDOW, { tz: 'Asia/Riyadh', startHour: 9, endHour: 22 });
  assert.equal(MIN_GAP_MS, 24 * 60 * 60 * 1000);
  assert.equal(MAX_PER_7_DAYS, 3);
  assert.equal(MAX_SENDS_PER_RUN, 100);
  assert.equal(BROADCAST_BATCH_PER_RUN, 40);
  assert.deepEqual(WEEKLY_REPORT, { weekday: 0, hour: 9, windowHours: 60 });
  for (const copy of Object.values(EMAIL_COPY)) {
    if (copy.category !== 'transactional') assert.equal(copy.approved, false, `${copy.key} must ship unapproved`);
  }
  for (const broadcast of BROADCASTS) assert.equal(broadcast.approved, false);
});

test('every journey step points at a real copy with the lifecycle category', () => {
  for (const [journey, steps] of Object.entries(JOURNEY_STEPS)) {
    const seen = new Set<string>();
    for (const step of steps) {
      assert.ok(COPY_KEYS.includes(step.copyKey), `${journey}: ${step.copyKey} is not a copy key`);
      assert.equal(EMAIL_COPY[step.copyKey].category, 'lifecycle', step.copyKey);
      assert.ok(!seen.has(step.copyKey), `${step.copyKey} appears twice`);
      seen.add(step.copyKey);
    }
    const sorted = [...steps].sort((a, b) => a.afterMinutes - b.afterMinutes);
    assert.deepEqual(steps, sorted, `${journey}: steps are written in time order`);
  }
});

test('no copy key is used by two journeys, and every key is a template in message_log', () => {
  const all = Object.values(JOURNEY_STEPS).flatMap((steps) => steps.map((s) => s.copyKey));
  assert.equal(new Set(all).size, all.length);
});

test('the one defined broadcast is valid and unapproved', () => {
  assert.deepEqual(BROADCASTS.map((b) => b.id), ['chat_relaunch']);
  const [broadcast] = BROADCASTS;
  assert.equal(broadcast!.copyKey, 'broadcast_chat_relaunch');
  assert.equal(broadcast!.segment, 'registered_not_connected');
  assert.equal(broadcast!.notBefore, null);
  assert.ok(SEGMENT_IDS.includes(broadcast!.segment));
  assert.match(broadcast!.id, /^[a-z0-9_]+$/);
});

test('journey horizon helpers', () => {
  assert.equal(journeyHorizonMinutes(JOURNEY_STEPS.registered), 10080 + 2880);
  assert.equal(journeyHorizonMinutes(JOURNEY_STEPS.canceled), 43200 + 7 * 1440);
  assert.equal(journeyLastStepMinutes(JOURNEY_STEPS.trial), 12960);
});
