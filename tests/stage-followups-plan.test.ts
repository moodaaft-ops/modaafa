import assert from 'node:assert/strict';
import test from 'node:test';
import type { FollowupStep } from '../config/stage-followups';
import { planFollowups, type PlanInput, type PlanUser } from '../lib/stages/plan';
import type { UserEventType } from '../lib/stages/types';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const COHORT = '2026-10-12T00:00:00Z';
const T0 = Date.parse('2026-10-12T10:00:00Z');

const steps: Record<string, FollowupStep[]> = {
  registered: [
    { key: 'registered_1h', afterMinutes: 60, approved: true },
    { key: 'registered_1d', afterMinutes: 1440, approved: true },
    { key: 'registered_3d', afterMinutes: 4320, approved: true },
  ],
  connected: [
    { key: 'connected_15m', afterMinutes: 15, approved: true },
    { key: 'connected_1d', afterMinutes: 1440, approved: true },
  ],
};

function user(overrides: Partial<PlanUser> = {}): PlanUser {
  return {
    id: 'u1',
    name: 'سلمان',
    email: 'u1@example.com',
    stage: 'registered',
    messagesOptOut: false,
    hasSubscription: false,
    ...overrides,
  };
}

/** Every user registered at T0 unless a test says otherwise. */
function registeredAt(users: PlanUser[], iso = new Date(T0).toISOString()) {
  return new Map<string, Partial<Record<UserEventType, string>>>(
    users.map((u) => [u.id, { registration_completed: iso }])
  );
}

function plan(at: number, users: PlanUser[], extra: Partial<PlanInput> = {}) {
  const eventsByUser = registeredAt(users);
  for (const [id, events] of extra.eventsByUser ?? []) {
    eventsByUser.set(id, { ...(eventsByUser.get(id) ?? {}), ...events });
  }
  return planFollowups({
    now: new Date(at),
    users,
    logsByUser: new Map(),
    steps: steps as PlanInput['steps'],
    cohortStart: COHORT,
    minGapMs: DAY,
    maxAttempts: 3,
    ...extra,
    eventsByUser,
  });
}

test('nothing is due before the first delay and the step appears right after it', () => {
  assert.equal(plan(T0 + 59 * MIN, [user()]).sends.length, 0);
  const due = plan(T0 + 61 * MIN, [user()]);
  assert.deepEqual(due.sends.map((s) => s.stepKey), ['registered_1h']);
});

test('without a cohort start date nobody is eligible', () => {
  const result = plan(T0 + DAY, [user()], { cohortStart: null });
  assert.equal(result.sends.length, 0);
  assert.equal(result.ignored.no_cohort, 1);
});

test('a user who registered before the cohort start is never messaged', () => {
  const old = user();
  const result = plan(T0 + 30 * DAY, [old], {
    eventsByUser: new Map([[old.id, { registration_completed: '2026-10-01T10:00:00Z' }]]),
  });
  assert.equal(result.sends.length, 0);
  assert.equal(result.ignored.before_cohort, 1);
});

test('a user with no registration_completed event (signed up before tracking, or never confirmed) is never messaged', () => {
  const result = planFollowups({
    now: new Date(T0 + 30 * DAY),
    users: [user()],
    eventsByUser: new Map(),
    logsByUser: new Map(),
    steps: steps as PlanInput['steps'],
    cohortStart: COHORT,
    minGapMs: DAY,
    maxAttempts: 3,
  });
  assert.equal(result.sends.length, 0);
  assert.equal(result.ignored.no_registration_event, 1);
});

test('opted-out, email-less and subscribed users are ignored', () => {
  const result = plan(T0 + 2 * DAY, [
    user({ id: 'a', messagesOptOut: true }),
    user({ id: 'b', email: null }),
    user({ id: 'c', hasSubscription: true }),
  ]);
  assert.equal(result.sends.length, 0);
  assert.equal(result.ignored.opted_out, 1);
  assert.equal(result.ignored.no_email, 1);
  assert.equal(result.ignored.has_subscription, 1);
});

test('steps that are not approved are never planned', () => {
  const unapproved = { registered: steps.registered.map((s) => ({ ...s, approved: false })) };
  assert.equal(plan(T0 + 5 * DAY, [user()], { steps: unapproved as PlanInput['steps'] }).sends.length, 0);
});

test('when several steps are overdue only the latest goes out and the older ones are recorded as superseded', () => {
  const result = plan(T0 + 2 * DAY, [user()]);
  assert.deepEqual(result.sends.map((s) => s.stepKey), ['registered_1d']);
  assert.deepEqual(result.skips.map((s) => s.stepKey), ['registered_1h']);
});

test('a step already sent is not planned again and the next one waits for its time', () => {
  const logsByUser = new Map([
    ['u1', [{ templateKey: 'registered_1h', status: 'sent' as const, attempts: 1, sentAt: new Date(T0 + 61 * MIN).toISOString() }]],
  ]);
  assert.equal(plan(T0 + 2 * 60 * MIN, [user()], { logsByUser }).sends.length, 0);
  const later = plan(T0 + DAY + 2 * 60 * MIN, [user()], { logsByUser });
  assert.deepEqual(later.sends.map((s) => s.stepKey), ['registered_1d']);
});

test('the daily limit holds the next message back until 24 hours after the last one', () => {
  const sentAt = new Date(T0 + 61 * MIN).toISOString();
  const logsByUser = new Map([
    ['u1', [{ templateKey: 'registered_1h', status: 'sent' as const, attempts: 1, sentAt }]],
  ]);
  // registered_1d is due at T0 + 24h, but the last send was at T0 + 61m.
  const blocked = plan(T0 + DAY + 10 * MIN, [user()], { logsByUser });
  assert.equal(blocked.sends.length, 0);
  assert.equal(blocked.ignored.daily_limit, 1);
  const open = plan(T0 + DAY + 62 * MIN, [user()], { logsByUser });
  assert.deepEqual(open.sends.map((s) => s.stepKey), ['registered_1d']);
});

test('moving to a later stage stops the old stage and starts the new one from its own entry time', () => {
  const connectedAt = T0 + 30 * MIN;
  const connected = user({ stage: 'connected' });
  const eventsByUser = new Map([['u1', { ads_account_connected: new Date(connectedAt).toISOString() }]]);
  // 3 days later the registered_3d step would be due, but the user is in "connected" now.
  const result = plan(T0 + 3 * DAY + MIN, [connected], { eventsByUser });
  const keys = result.sends.map((s) => s.stepKey);
  assert.ok(!keys.includes('registered_3d'));
  assert.deepEqual(keys, ['connected_1d']);
});

test('a failed send is retried until the attempts run out', () => {
  const failed = (attempts: number) =>
    new Map([['u1', [{ templateKey: 'registered_1h', status: 'failed' as const, attempts, sentAt: null }]]]);
  assert.deepEqual(plan(T0 + 2 * 60 * MIN, [user()], { logsByUser: failed(1) }).sends.map((s) => s.stepKey), ['registered_1h']);
  assert.equal(plan(T0 + 2 * 60 * MIN, [user()], { logsByUser: failed(3) }).sends.length, 0);
});

test('registered stops after the third step', () => {
  const logsByUser = new Map([
    ['u1', ['registered_1h', 'registered_1d', 'registered_3d'].map((templateKey) => ({
      templateKey,
      status: 'sent' as const,
      attempts: 1,
      sentAt: new Date(T0).toISOString(),
    }))],
  ]);
  assert.equal(plan(T0 + 30 * DAY, [user()], { logsByUser }).sends.length, 0);
});
