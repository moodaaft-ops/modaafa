import assert from 'node:assert/strict';
import test from 'node:test';
import { planEmails, type PlanConfig, type PlanContext, type PlanLogRow } from '../lib/lifecycle/plan';
import { ACTIVATED_AT, approvedCopy, makeCtx, riyadh, sentLog } from './support/lifecycle';

const copy = approvedCopy();
const none = () => false;

function plan(contexts: PlanContext[], now: Date, config: Partial<PlanConfig> = {}, withCopy = copy) {
  return planEmails({ now, contexts, copy: withCopy, config: { activatedAt: ACTIVATED_AT, isHeldOut: none, ...config } });
}

/** A user registered at `at` (Riyadh local), still in the registered stage. */
const registered = (at: string, extra: Parameters<typeof makeCtx>[0] = {}) =>
  makeCtx({ events: { registration_completed: riyadh(at).toISOString() }, ...extra });

const keys = (result: ReturnType<typeof plan>) => result.sends.map((s) => `${s.userId}:${s.templateKey}`);

/** On a trial since Wed 14 Oct 10:00. */
const trialing = (extra: Parameters<typeof makeCtx>[0] = {}) =>
  makeCtx({
    user: { stage: 'analysis_viewed' },
    subscription: { status: 'trialing', createdAt: riyadh('2026-10-14T10:00').toISOString() },
    ...extra,
  });
/** A paying subscriber (no journey, only the weekly report). */
const active = (extra: Parameters<typeof makeCtx>[0] = {}) =>
  makeCtx({
    user: { stage: 'subscribed' },
    subscription: { status: 'active', createdAt: riyadh('2026-09-01T10:00').toISOString() },
    events: { subscription_paid: riyadh('2026-09-15T10:00').toISOString() },
    ...extra,
  });

// ---------------------------------------------------------------------------
// The basics
// ---------------------------------------------------------------------------

test('a registered user gets registered_1d once the day has passed, not before', () => {
  const ctx = registered('2026-10-10T10:00');
  assert.deepEqual(keys(plan([ctx], riyadh('2026-10-11T09:59'))), []);
  const result = plan([ctx], riyadh('2026-10-11T10:00'));
  assert.deepEqual(keys(result), ['u1:registered_1d']);
  const [send] = result.sends;
  assert.equal(send!.kind, 'journey');
  assert.equal(send!.journey, 'registered');
  assert.equal(send!.category, 'lifecycle');
  assert.equal(send!.dueAt, riyadh('2026-10-11T10:00').toISOString());
});

test('nothing is planned while the activation moment is null', () => {
  const result = plan([registered('2026-10-10T10:00')], riyadh('2026-10-12T12:00'), { activatedAt: null });
  assert.deepEqual(result.sends, []);
  assert.equal(result.ignored.not_activated, 1);
});

test('activation: a step due before the activation moment is never sent, a later step still is', () => {
  // Activation is 1 Oct 00:00. Registered 24 Sep: 1d (25 Sep), 3d (27 Sep) and 7d (1 Oct 10:00) steps.
  const ctx = registered('2026-09-24T10:00');
  const early = plan([ctx], riyadh('2026-09-30T12:00'));
  assert.deepEqual(keys(early), []);
  assert.equal(early.ignored.before_activation, 1);
  assert.deepEqual(early.skips, [], 'pre-activation steps are ignored, never written down');

  const later = plan([ctx], riyadh('2026-10-01T10:30'));
  assert.deepEqual(keys(later), ['u1:registered_7d']);
});

test('a step due exactly at the activation moment is allowed', () => {
  const ctx = registered('2026-09-30T00:00'); // registered_1d due 1 Oct 00:00
  const result = plan([ctx], riyadh('2026-10-01T09:00'), { activatedAt: riyadh('2026-10-01T00:00').toISOString() });
  assert.deepEqual(keys(result), ['u1:registered_1d']);
});

test('copy that is not approved is ignored and nothing is recorded', () => {
  const unapproved = { ...copy, registered_1d: { ...copy.registered_1d, approved: false } };
  const result = plan([registered('2026-10-10T10:00')], riyadh('2026-10-11T12:00'), {}, unapproved);
  assert.deepEqual(result.sends, []);
  assert.deepEqual(result.skips, []);
  assert.equal(result.ignored.not_approved, 1);
});

test('the shipped stubs are all unapproved, so the real config plans nothing', () => {
  const result = planEmails({
    now: riyadh('2026-10-11T12:00'),
    contexts: [registered('2026-10-10T10:00')],
    config: { activatedAt: ACTIVATED_AT, isHeldOut: none },
  });
  assert.deepEqual(result.sends, []);
  assert.equal(result.ignored.not_approved, 1);
});

test('only the approved steps of a journey are used: an approved later step still goes out', () => {
  const partly = { ...copy, registered_1d: { ...copy.registered_1d, approved: false } };
  const ctx = registered('2026-10-10T10:00');
  assert.deepEqual(keys(plan([ctx], riyadh('2026-10-11T12:00'), {}, partly)), []);
  assert.deepEqual(keys(plan([ctx], riyadh('2026-10-13T12:00'), {}, partly)), ['u1:registered_3d']);
});

// ---------------------------------------------------------------------------
// Expiry and superseded
// ---------------------------------------------------------------------------

test('expiry: a step is sendable for 48 hours after its due time, then skipped as expired', () => {
  // Trial started Wed 14 Oct 10:00: trial_d1 due Thu 15 Oct 10:00, expires Sat 17 Oct 10:00, and the
  // next step (trial_d4) is not due until Mon 19 Oct, so nothing supersedes it at the boundary.
  const ctx = trialing();
  const atBoundary = plan([ctx], riyadh('2026-10-17T10:00'));
  assert.deepEqual(keys(atBoundary), ['u1:trial_d1'], 'exactly 48 h is still sendable');
  assert.deepEqual(atBoundary.skips, []);

  const pastBoundary = plan([ctx], riyadh('2026-10-17T10:01'));
  assert.deepEqual(pastBoundary.sends, []);
  assert.deepEqual(
    pastBoundary.skips.map((s) => `${s.templateKey}:${s.reason}`),
    ['trial_d1:expired']
  );
});

test('expiry: an expired step does not block the next one, which is sent', () => {
  const ctx = registered('2026-10-10T10:00'); // 1d expired, 3d due 13 Oct 10:00
  const result = plan([ctx], riyadh('2026-10-13T12:00'));
  assert.deepEqual(keys(result), ['u1:registered_3d']);
  assert.deepEqual(result.skips.map((s) => `${s.templateKey}:${s.reason}`), ['registered_1d:expired']);
});

test('expiry: steps with a longer expiry (7 days) stay sendable that long', () => {
  const lapsed = (canceledAt: string) =>
    makeCtx({
      user: { stage: 'analysis_viewed' },
      subscription: { status: 'canceled', createdAt: riyadh('2026-10-01T10:00').toISOString(), canceledAt: riyadh(canceledAt).toISOString() },
      events: { first_analysis_viewed: riyadh('2026-09-30T10:00').toISOString() },
      logs: [sentLog('trial_lapsed_2d', riyadh('2026-10-04T10:00'))],
    });
  // canceled 2 Oct 10:00: trial_lapsed_14d is due 16 Oct 10:00 and expires 23 Oct 10:00.
  const ctx = lapsed('2026-10-02T10:00');
  assert.deepEqual(keys(plan([ctx], riyadh('2026-10-23T10:00'))), ['u1:trial_lapsed_14d']);
  const late = plan([ctx], riyadh('2026-10-23T10:01'));
  assert.deepEqual(keys(late), []);
  assert.deepEqual(late.skips.map((s) => `${s.templateKey}:${s.reason}`), ['trial_lapsed_14d:expired']);
});

test('superseded: when two steps are overdue only the latest goes out, the earlier one is recorded', () => {
  const ctx = makeCtx({
    user: { stage: 'connected' },
    events: { ads_account_connected: riyadh('2026-10-10T10:00').toISOString() },
  });
  // connected_3h due 10 Oct 13:00, connected_1d due 11 Oct 10:00; both inside 48 h at 11 Oct 12:00.
  const result = plan([ctx], riyadh('2026-10-11T12:00'));
  assert.deepEqual(keys(result), ['u1:connected_1d']);
  assert.deepEqual(result.skips.map((s) => `${s.templateKey}:${s.reason}`), ['connected_3h:superseded']);
  assert.equal(result.skips[0]!.category, 'lifecycle');
});

test('superseded: an earlier step is obsolete once a later one has been sent', () => {
  const ctx = makeCtx({
    user: { stage: 'connected' },
    events: { ads_account_connected: riyadh('2026-10-10T10:00').toISOString() },
    logs: [sentLog('connected_1d', riyadh('2026-10-11T10:30'))],
  });
  const result = plan([ctx], riyadh('2026-10-12T12:00'));
  assert.deepEqual(keys(result), []);
  assert.deepEqual(result.skips.map((s) => `${s.templateKey}:${s.reason}`), ['connected_3h:superseded']);
});

test('a step already in message_log (sent, skipped, in flight) is never sent again', () => {
  for (const status of ['sent', 'skipped', 'sending'] as const) {
    const ctx = registered('2026-10-10T10:00', {
      logs: [{ templateKey: 'registered_1d', status, attempts: 1, sentAt: status === 'sent' ? riyadh('2026-10-11T10:00').toISOString() : null, category: 'lifecycle' }],
    });
    assert.deepEqual(keys(plan([ctx], riyadh('2026-10-12T12:00'))), [], status);
  }
});

test('a failed step is retried until it has used its attempts, then it is settled', () => {
  const failed = (attempts: number): PlanLogRow[] => [{ templateKey: 'registered_1d', status: 'failed', attempts, sentAt: null, category: null }];
  const now = riyadh('2026-10-11T12:00');
  assert.deepEqual(keys(plan([registered('2026-10-10T10:00', { logs: failed(1) })], now)), ['u1:registered_1d']);
  assert.deepEqual(keys(plan([registered('2026-10-10T10:00', { logs: failed(2) })], now)), ['u1:registered_1d']);
  assert.deepEqual(keys(plan([registered('2026-10-10T10:00', { logs: failed(3) })], now)), []);
});

// ---------------------------------------------------------------------------
// Current journey only
// ---------------------------------------------------------------------------

test('a user who moved on stops getting the old journey: connected users never get registered steps', () => {
  const ctx = makeCtx({
    user: { stage: 'connected' },
    events: {
      registration_completed: riyadh('2026-10-08T10:00').toISOString(),
      ads_account_connected: riyadh('2026-10-10T10:00').toISOString(),
    },
  });
  const result = plan([ctx], riyadh('2026-10-11T12:00'));
  assert.deepEqual(keys(result), ['u1:connected_1d']);
  assert.ok(!result.skips.some((s) => s.templateKey.startsWith('registered')));
});

test('each journey sends its own steps: plan_ready, trial, trial_lapsed, canceled, past_due', () => {
  const sub = (status: string, extra: Record<string, string | null> = {}) => ({
    status,
    createdAt: riyadh('2026-10-10T10:00').toISOString(),
    ...extra,
  });
  const cases: Array<[string, PlanContext, Date, string]> = [
    ['plan_ready', makeCtx({ user: { stage: 'analysis_viewed' }, events: { first_analysis_viewed: riyadh('2026-10-10T10:00').toISOString() } }), riyadh('2026-10-11T12:00'), 'plan_ready_1d'],
    // Started Tue 13 Oct, so the weekly report window (Sunday to Tuesday evening) is closed on Wednesday.
    ['trial', makeCtx({ user: { stage: 'analysis_viewed' }, subscription: sub('trialing', { createdAt: riyadh('2026-10-13T10:00').toISOString() }) }), riyadh('2026-10-14T12:00'), 'trial_d1'],
    ['trial_lapsed', makeCtx({ user: { stage: 'analysis_viewed' }, subscription: sub('canceled', { canceledAt: riyadh('2026-10-10T10:00').toISOString() }) }), riyadh('2026-10-12T12:00'), 'trial_lapsed_2d'],
    ['canceled', makeCtx({ user: { stage: 'subscribed' }, subscription: sub('canceled', { canceledAt: riyadh('2026-10-10T10:00').toISOString() }), events: { subscription_paid: riyadh('2026-10-05T10:00').toISOString() } }), riyadh('2026-10-11T12:00'), 'canceled_1d'],
    // The unpaid period started Mon 5 Oct; access ends after 7 days and the mail is due a day later (Tue 13 Oct 10:00).
    ['past_due', makeCtx({ user: { stage: 'subscribed' }, subscription: sub('past_due', { currentPeriodStart: riyadh('2026-10-05T10:00').toISOString(), lastEventAt: riyadh('2026-10-12T10:00').toISOString() }), events: { subscription_paid: riyadh('2026-10-01T10:00').toISOString() } }), riyadh('2026-10-13T12:00'), 'past_due_3d'],
  ];
  for (const [journey, ctx, now, expected] of cases) {
    const result = plan([ctx], now);
    assert.deepEqual(keys(result), [`u1:${expected}`], journey);
    assert.equal(result.sends[0]!.journey, journey);
  }
});

test('past_due_3d is due 8 days after the unpaid period started, and a later Stripe retry never moves it', () => {
  const periodStart = riyadh('2026-10-05T10:00');
  const pastDue = (lastEventAt: string) =>
    makeCtx({
      user: { stage: 'subscribed' },
      subscription: { status: 'past_due', createdAt: riyadh('2026-09-01T10:00').toISOString(), currentPeriodStart: periodStart.toISOString(), lastEventAt },
      events: { subscription_paid: riyadh('2026-09-02T10:00').toISOString() },
    });
  // Each retry of the card bumps last_event_at. The mail time must not follow it.
  for (const retryAt of ['2026-10-05T10:05', '2026-10-08T10:00', '2026-10-11T10:00', '2026-10-12T10:00']) {
    const ctx = pastDue(riyadh(retryAt).toISOString());
    // The access grace (7 days) is still running on Mon 12 Oct 12:00: nothing yet.
    assert.deepEqual(keys(plan([ctx], riyadh('2026-10-12T12:00'))), [], retryAt);
    // Due exactly 8 days after the period start.
    assert.deepEqual(keys(plan([ctx], riyadh('2026-10-13T09:59'))), [], retryAt);
    const result = plan([ctx], riyadh('2026-10-13T10:00'));
    assert.deepEqual(keys(result), ['u1:past_due_3d'], retryAt);
    assert.equal(result.sends[0]!.dueAt, new Date(periodStart.getTime() + 8 * 24 * 60 * 60 * 1000).toISOString());
  }
});

test('trial_lapsed and canceled are due after the subscription ended, not after the cancel request', () => {
  const requested = riyadh('2026-10-02T10:00').toISOString();
  const ended = riyadh('2026-10-10T10:00').toISOString();
  const lapsed = makeCtx({
    user: { stage: 'analysis_viewed' },
    subscription: { status: 'canceled', createdAt: riyadh('2026-09-26T10:00').toISOString(), trialEndsAt: ended, canceledAt: requested, lastEventAt: ended },
  });
  const canceled = makeCtx({
    user: { id: 'u2', stage: 'subscribed' },
    subscription: { status: 'canceled', createdAt: riyadh('2026-08-01T10:00').toISOString(), canceledAt: requested, lastEventAt: ended },
    events: { subscription_paid: riyadh('2026-08-02T10:00').toISOString() },
  });
  // Two days after the request, one after: the old anchor would already have sent both.
  assert.deepEqual(keys(plan([lapsed, canceled], riyadh('2026-10-11T09:00'))), []);
  assert.deepEqual(keys(plan([lapsed, canceled], riyadh('2026-10-11T10:00'))), ['u2:canceled_1d']);
  assert.deepEqual(keys(plan([lapsed, canceled], riyadh('2026-10-12T10:00'))), ['u2:canceled_1d', 'u1:trial_lapsed_2d']);
});

test('a trial refused at its start (card or ads account already used) gets no trial_lapsed mail', () => {
  const refused = makeCtx({
    user: { stage: 'analysis_viewed' },
    subscription: {
      status: 'canceled',
      createdAt: riyadh('2026-10-01T10:00').toISOString(),
      trialEndsAt: riyadh('2026-10-15T10:00').toISOString(),
      canceledAt: riyadh('2026-10-01T10:00').toISOString(),
      lastEventAt: riyadh('2026-10-01T10:01').toISOString(),
    },
  });
  for (const now of ['2026-10-04T12:00', '2026-10-10T12:00', '2026-10-16T12:00']) {
    const result = plan([refused], riyadh(now));
    assert.deepEqual(result.sends, [], now);
    assert.deepEqual(result.skips, [], 'nothing is recorded for them either');
    assert.equal(result.ignored.no_journey, 1);
  }
});

test('active and paused subscribers get no journey mail', () => {
  for (const status of ['active', 'paused']) {
    const ctx = makeCtx({
      user: { stage: 'subscribed' },
      subscription: { status, createdAt: riyadh('2026-09-01T10:00').toISOString() },
      events: { subscription_paid: riyadh('2026-09-15T10:00').toISOString() },
    });
    const result = plan([ctx], riyadh('2026-10-14T12:00'));
    assert.deepEqual(result.sends, []);
    assert.equal(result.ignored.no_journey, 1);
  }
});

// ---------------------------------------------------------------------------
// Limits: window, gap, 7-day cap
// ---------------------------------------------------------------------------

test('send window: nothing before 09:00 or from 22:00 Riyadh, the step waits for the window', () => {
  const ctx = registered('2026-10-10T08:00'); // registered_1d due 11 Oct 08:00, before the window opens
  for (const [at, inside] of [
    ['2026-10-11T08:59', false],
    ['2026-10-11T09:00', true],
    ['2026-10-11T20:59', true],
    ['2026-10-11T21:59', true],
    ['2026-10-11T22:00', false],
    ['2026-10-12T00:30', false],
  ] as const) {
    const result = plan([ctx], riyadh(at));
    assert.equal(result.sends.length, inside ? 1 : 0, at);
    if (!inside) assert.equal(result.ignored.outside_window, 1, at);
  }
});

test('send window: a step due at night goes out the next morning, not the same night', () => {
  const ctx = registered('2026-10-10T23:00'); // due 11 Oct 23:00, outside the window
  assert.deepEqual(keys(plan([ctx], riyadh('2026-10-11T23:05'))), []);
  assert.deepEqual(keys(plan([ctx], riyadh('2026-10-12T09:00'))), ['u1:registered_1d']);
});

test('min gap: nothing within 24 hours of the last optional mail, allowed at exactly 24 hours', () => {
  const ctx = (sentAt: string) => registered('2026-10-10T10:00', { logs: [sentLog('welcome_ads_connect', riyadh(sentAt), 'onboarding')] });
  const now = riyadh('2026-10-11T12:00');
  const blocked = plan([ctx('2026-10-10T12:01')], now);
  assert.deepEqual(blocked.sends, []);
  assert.equal(blocked.ignored.min_gap, 1);
  assert.deepEqual(keys(plan([ctx('2026-10-10T12:00')], now)), ['u1:registered_1d']);
});

test('the welcome mail counts toward the gap (it is onboarding, not transactional)', () => {
  const ctx = registered('2026-10-10T10:00', { logs: [sentLog('welcome_ads_connect', riyadh('2026-10-11T09:30'), 'onboarding')] });
  assert.equal(plan([ctx], riyadh('2026-10-11T12:00')).ignored.min_gap, 1);
});

test('transactional mail never counts toward the gap or the cap', () => {
  const logs = [
    sentLog('tx_subscription_welcome', riyadh('2026-10-11T11:00'), 'transactional'),
    sentLog('tx_trial_ending', riyadh('2026-10-10T11:00'), 'transactional'),
    sentLog('tx_payment_failed', riyadh('2026-10-09T11:00'), 'transactional'),
  ];
  const ctx = registered('2026-10-10T10:00', { logs });
  assert.deepEqual(keys(plan([ctx], riyadh('2026-10-11T12:00'))), ['u1:registered_1d']);
});

test('legacy rows with no category count as optional mail', () => {
  const ctx = registered('2026-10-10T10:00', { logs: [sentLog('registered_1h', riyadh('2026-10-11T11:00'), null)] });
  assert.equal(plan([ctx], riyadh('2026-10-11T12:00')).ignored.min_gap, 1);
});

test('failed, skipped and in-flight rows do not count toward the gap', () => {
  const logs: PlanLogRow[] = [
    { templateKey: 'a', status: 'failed', attempts: 1, sentAt: riyadh('2026-10-11T11:00').toISOString(), category: 'lifecycle' },
    { templateKey: 'b', status: 'skipped', attempts: 0, sentAt: null, category: 'lifecycle' },
  ];
  const ctx = registered('2026-10-10T10:00', { logs });
  assert.deepEqual(keys(plan([ctx], riyadh('2026-10-11T12:00'))), ['u1:registered_1d']);
});

test('seven-day cap: three optional mails in the last 7 days block a fourth', () => {
  const logs = [
    sentLog('x1', riyadh('2026-10-05T11:00')),
    sentLog('x2', riyadh('2026-10-07T11:00')),
    sentLog('x3', riyadh('2026-10-09T11:00')),
  ];
  const ctx = registered('2026-10-10T10:00', { logs });
  const blocked = plan([ctx], riyadh('2026-10-11T12:00'));
  assert.deepEqual(blocked.sends, []);
  assert.equal(blocked.ignored.max_per_7_days, 1);
  // Two in the window is fine.
  assert.deepEqual(keys(plan([registered('2026-10-10T10:00', { logs: logs.slice(1) })], riyadh('2026-10-11T12:00'))), ['u1:registered_1d']);
});

test('seven-day cap: a mail exactly 7 days old has left the window', () => {
  const logs = [
    sentLog('x1', riyadh('2026-10-04T12:00')), // exactly 7 days before the plan time
    sentLog('x2', riyadh('2026-10-07T11:00')),
    sentLog('x3', riyadh('2026-10-09T11:00')),
  ];
  const ctx = registered('2026-10-10T10:00', { logs });
  assert.deepEqual(keys(plan([ctx], riyadh('2026-10-11T12:00'))), ['u1:registered_1d']);
  // One minute earlier it still counts.
  assert.equal(plan([ctx], riyadh('2026-10-11T11:59')).ignored.max_per_7_days, 1);
});

test('the cap is configurable and the gap too', () => {
  const logs = [sentLog('x1', riyadh('2026-10-09T11:00'))];
  const ctx = registered('2026-10-10T10:00', { logs });
  const now = riyadh('2026-10-11T12:00');
  assert.equal(plan([ctx], now, { maxPer7Days: 1 }).ignored.max_per_7_days, 1);
  assert.equal(plan([ctx], now, { minGapMs: 72 * 3600 * 1000 }).ignored.min_gap, 1);
});

// ---------------------------------------------------------------------------
// Preferences, suppression, holdout
// ---------------------------------------------------------------------------

test('preferences: a lifecycle category switched off blocks journey mail, other keys do not', () => {
  const now = riyadh('2026-10-11T12:00');
  const off = registered('2026-10-10T10:00', { user: { emailPrefs: { lifecycle: false } } });
  const result = plan([off], now);
  assert.deepEqual(result.sends, []);
  assert.equal(result.ignored.category_off, 1);
  assert.deepEqual(result.skips, [], 'a switched-off category records nothing');

  const otherOff = registered('2026-10-10T10:00', { user: { emailPrefs: { weekly_report: false, product_news: false } } });
  assert.equal(plan([otherOff], now).sends.length, 1);

  const explicitOn = registered('2026-10-10T10:00', { user: { emailPrefs: { lifecycle: true } } });
  assert.equal(plan([explicitOn], now).sends.length, 1);
});

test('preferences: messages_opt_out (#81) turns every optional category off', () => {
  const ctx = registered('2026-10-10T10:00', { user: { messagesOptOut: true } });
  const result = plan([ctx], riyadh('2026-10-11T12:00'));
  assert.deepEqual(result.sends, []);
  assert.equal(result.ignored.opted_out, 1);
});

test('suppression: a bounced address gets nothing, whatever the journey', () => {
  const suppressed = { emailSuppressedAt: '2026-10-09T10:00:00Z' };
  const pastDue = makeCtx({
    user: { stage: 'subscribed', ...suppressed },
    subscription: { status: 'past_due', createdAt: riyadh('2026-10-01T10:00').toISOString(), lastEventAt: riyadh('2026-10-05T10:00').toISOString() },
    events: { subscription_paid: riyadh('2026-10-02T10:00').toISOString() },
  });
  const result = plan([registered('2026-10-10T10:00', { user: suppressed }), pastDue], riyadh('2026-10-12T12:00'));
  assert.deepEqual(result.sends, []);
  assert.equal(result.ignored.suppressed, 2);
});

test('a user with no email address is ignored', () => {
  const result = plan([registered('2026-10-10T10:00', { user: { email: null } })], riyadh('2026-10-11T12:00'));
  assert.deepEqual(result.sends, []);
  assert.equal(result.ignored.no_email, 1);
});

test('holdout: held-out users get no journey mail and nothing is recorded for them', () => {
  const held = registered('2026-10-10T10:00', { user: { id: 'held' } });
  const other = registered('2026-10-10T10:00', { user: { id: 'other' } });
  const result = plan([held, other], riyadh('2026-10-14T12:00'), { isHeldOut: (id) => id === 'held' });
  assert.deepEqual(keys(result), ['other:registered_3d']);
  assert.equal(result.ignored.holdout, 1);
  assert.ok(result.skips.every((s) => s.userId !== 'held'), 'no skip rows for held-out users');
});

test('holdout does not apply to past_due', () => {
  const ctx = makeCtx({
    user: { id: 'held', stage: 'subscribed' },
    subscription: { status: 'past_due', createdAt: riyadh('2026-10-01T10:00').toISOString(), currentPeriodStart: riyadh('2026-10-05T10:00').toISOString() },
    events: { subscription_paid: riyadh('2026-10-02T10:00').toISOString() },
  });
  assert.deepEqual(keys(plan([ctx], riyadh('2026-10-13T12:00'), { isHeldOut: () => true })), ['held:past_due_3d']);
});

test('the default holdout uses the real hash at HOLDOUT_PERCENT', () => {
  const contexts = Array.from({ length: 400 }, (_, i) =>
    registered('2026-10-10T10:00', { user: { id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, email: `u${i}@example.com` } })
  );
  const result = planEmails({ now: riyadh('2026-10-11T12:00'), contexts, copy, config: { activatedAt: ACTIVATED_AT } });
  assert.equal(result.sends.length + result.ignored.holdout, 400);
  assert.ok(result.ignored.holdout > 20 && result.ignored.holdout < 60, `held out ${result.ignored.holdout}`);
});

// ---------------------------------------------------------------------------
// Weekly report
// ---------------------------------------------------------------------------

test('weekly report: Saturday night and Sunday 08:59 send nothing, Sunday 09:00 sends the week key', () => {
  const ctx = active();
  assert.deepEqual(plan([ctx], riyadh('2026-10-17T23:00')).sends, []);
  assert.deepEqual(plan([ctx], riyadh('2026-10-18T08:59')).sends, []);
  const result = plan([ctx], riyadh('2026-10-18T09:00'));
  assert.deepEqual(keys(result), ['u1:weekly_report_2026-W42']);
  const [send] = result.sends;
  assert.equal(send!.kind, 'weekly');
  assert.equal(send!.copyKey, 'weekly_report');
  assert.equal(send!.category, 'weekly_report');
  assert.equal(send!.dueAt, riyadh('2026-10-18T09:00').toISOString());
});

test('weekly report: sendable for 60 hours, then the week is lost', () => {
  const ctx = active();
  assert.equal(plan([ctx], riyadh('2026-10-20T20:59')).sends.length, 1);
  assert.equal(plan([ctx], riyadh('2026-10-20T21:00')).sends.length, 0);
});

test('weekly report: once per week, a new key the week after', () => {
  const sent = active({ logs: [sentLog('weekly_report_2026-W42', riyadh('2026-10-18T09:05'), 'weekly_report')] });
  assert.deepEqual(plan([sent], riyadh('2026-10-19T12:00')).sends, [], 'already sent this week');
  assert.deepEqual(keys(plan([sent], riyadh('2026-10-25T09:00'))), ['u1:weekly_report_2026-W43']);
});

test('weekly report: trialing and active only', () => {
  const now = riyadh('2026-10-18T10:00');
  assert.equal(plan([trialing()], now).sends.length, 1);
  assert.equal(plan([active()], now).sends.length, 1);
  for (const status of ['past_due', 'canceled', 'paused']) {
    const ctx = makeCtx({ user: { stage: 'subscribed' }, subscription: { status, createdAt: riyadh('2026-09-01T10:00').toISOString(), canceledAt: riyadh('2026-10-01T10:00').toISOString() } });
    assert.ok(!plan([ctx], now).sends.some((s) => s.kind === 'weekly'), status);
  }
  assert.equal(plan([registered('2026-10-01T10:00')], now).sends.filter((s) => s.kind === 'weekly').length, 0);
});

test('weekly report obeys the gap, the window and the weekly_report preference', () => {
  const sunday = riyadh('2026-10-18T10:00');
  const gap = active({ logs: [sentLog('trial_d9', riyadh('2026-10-18T09:30'))] });
  assert.equal(plan([gap], sunday).ignored.min_gap, 1);
  assert.equal(plan([active()], riyadh('2026-10-18T22:00')).ignored.outside_window, 1);
  assert.equal(plan([active()], riyadh('2026-10-19T08:00')).ignored.outside_window, 1);
  assert.equal(plan([active()], riyadh('2026-10-19T09:00')).sends.length, 1, 'still inside the 60 hours the next morning');

  const off = active({ user: { emailPrefs: { weekly_report: false } } });
  const result = plan([off], sunday);
  assert.deepEqual(result.sends, []);
  assert.equal(result.ignored.category_off, 1);
  // Switching off lifecycle mail does not stop the weekly report.
  assert.equal(plan([active({ user: { emailPrefs: { lifecycle: false } } })], sunday).sends.length, 1);
});

test('weekly report is exempt from the holdout', () => {
  assert.equal(plan([active({ user: { id: 'held' } })], riyadh('2026-10-18T10:00'), { isHeldOut: () => true }).sends.length, 1);
});

test('weekly report before the activation moment is never sent', () => {
  const result = plan([active()], riyadh('2026-10-18T10:00'), { activatedAt: riyadh('2026-10-18T09:30').toISOString() });
  assert.deepEqual(result.sends, []);
  assert.equal(result.ignored.before_activation, 1);
  // The next Sunday is fine.
  assert.equal(plan([active()], riyadh('2026-10-25T10:00'), { activatedAt: riyadh('2026-10-18T09:30').toISOString() }).sends.length, 1);
});

test('weekly report and a journey step due together: the longer-waiting one goes first, the other follows after the gap', () => {
  // Trial started Mon 12 Oct 10:00: trial_d4 is due Fri 16 Oct, trial_d1 Tue 13 Oct (expired by Sunday).
  // Start Wed 14 Oct 10:00 instead: trial_d4 due Mon 19 Oct 10:00; weekly due Sun 18 Oct 09:00.
  const ctx = trialing();
  const sunday = plan([ctx], riyadh('2026-10-18T10:00'));
  assert.deepEqual(keys(sunday), ['u1:weekly_report_2026-W42'], 'the week-old trial_d1 is expired; weekly is the only candidate');

  const monday = plan(
    [trialing({ logs: [sentLog('weekly_report_2026-W42', riyadh('2026-10-18T09:05'), 'weekly_report'), sentLog('trial_d1', riyadh('2026-10-15T10:30'))] })],
    riyadh('2026-10-19T10:30')
  );
  assert.deepEqual(keys(monday), ['u1:trial_d4']);
});

test('weekly report and a journey step due at once: the older due time wins and the other waits', () => {
  // Trial created Thu 15 Oct 09:00 + 1d => trial_d1 due Fri 16 Oct 09:00 (sendable until Sun 18 Oct 09:00).
  // At Sun 18 Oct 09:00 both are sendable; trial_d1 has waited longer.
  const ctx = makeCtx({
    user: { stage: 'analysis_viewed' },
    subscription: { status: 'trialing', createdAt: riyadh('2026-10-15T09:00').toISOString() },
  });
  const result = plan([ctx], riyadh('2026-10-18T09:00'));
  assert.deepEqual(keys(result), ['u1:trial_d1']);
});

// ---------------------------------------------------------------------------
// Ordering and shape
// ---------------------------------------------------------------------------

test('a user appears at most once per run and sends are ordered by due time', () => {
  const a = registered('2026-10-10T10:00', { user: { id: 'a' } });
  const b = registered('2026-10-09T10:00', { user: { id: 'b' } });
  const c = registered('2026-10-10T10:00', { user: { id: 'c' } });
  const result = plan([a, b, c], riyadh('2026-10-11T12:00'));
  assert.deepEqual(keys(result), ['b:registered_1d', 'a:registered_1d', 'c:registered_1d']);
  assert.equal(new Set(result.sends.map((s) => s.userId)).size, 3);
});

test('ignored counts are one per user and track under the reason it stopped', () => {
  const contexts = [
    registered('2026-10-10T10:00', { user: { id: 'ok' } }),
    registered('2026-10-10T10:00', { user: { id: 'late' } }),
    makeCtx({ user: { id: 'old', stage: 'registered' } }),
    makeCtx({ user: { id: 'sub', stage: 'subscribed' }, subscription: { status: 'paused' } }),
  ];
  const result = plan(contexts, riyadh('2026-10-11T12:00'), { isHeldOut: (id) => id === 'late' });
  assert.deepEqual(keys(result), ['ok:registered_1d']);
  assert.equal(result.ignored.holdout, 1);
  assert.equal(result.ignored.no_journey, 2);
});
