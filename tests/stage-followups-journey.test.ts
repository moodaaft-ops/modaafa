import assert from 'node:assert/strict';
import test from 'node:test';
import type { FollowupStep } from '../config/stage-followups';
import { STAGE_FOLLOWUP_STEPS } from '../config/stage-followups';
import { send } from '../lib/messaging/send';
import { verifyOptOutToken } from '../lib/messaging/opt-out';
import { recordUserEvent } from '../lib/stages/events';
import { runStageFollowups } from '../lib/stages/run-followups';
import { createFakeAdmin } from './support/fake-admin';

const TESTER = '8f3b1c52-9d4e-4a6b-8c1d-2e7f5a9b0c33';
const COHORT = '2026-10-12T00:00:00Z';
const DAY_MS = 24 * 60 * 60 * 1000;
/** Day 0 is 12 Oct 2026. Built with date arithmetic so day 20 is 1 Nov, not "32 Oct". */
const at = (day: number, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(2026, 9, 12) + day * DAY_MS + (h! * 60 + m!) * 60_000);
};

const approvedSteps = Object.fromEntries(
  Object.entries(STAGE_FOLLOWUP_STEPS).map(([stage, list]) => [
    stage,
    (list as FollowupStep[]).map((step) => ({ ...step, approved: true })),
  ])
) as typeof STAGE_FOLLOWUP_STEPS;

const testerRow = (admin: { tables: Record<string, any[]> }) => admin.tables.users!.find((u: any) => u.id === TESTER);

function setup() {
  process.env.UNSUBSCRIBE_SECRET = 'test-unsubscribe-secret';
  process.env.NEXT_PUBLIC_APP_URL = 'https://ai.modaafa.com';
  const mail: Array<{ to: string; subject: string; html: string; footer?: string; headers?: Record<string, string> }> = [];
  const admin = createFakeAdmin({
    users: [
      { id: TESTER, email: 'tester@example.com', name: 'سلمان العتيبي', stage: 'registered', messages_opt_out: false },
      // Registered before the tracking existed: no registration_completed event at all.
      { id: 'old', email: 'old@example.com', name: 'قديم', stage: 'registered', messages_opt_out: false },
      // Has the event but from before the cohort start.
      { id: 'early', email: 'early@example.com', name: 'مبكر', stage: 'registered', messages_opt_out: false },
      { id: 'optout', email: 'optout@example.com', name: 'موقف', stage: 'registered', messages_opt_out: true },
      // Never confirmed the address, so registration_completed was never written.
      { id: 'unconfirmed', email: 'unconfirmed@example.com', name: 'ما أكد', stage: 'registered', messages_opt_out: false },
    ],
  });
  const registered: Record<string, string> = {
    [TESTER]: at(0, '10:00').toISOString(),
    early: '2026-10-01T10:00:00Z',
    optout: at(0, '10:00').toISOString(),
  };
  for (const [userId, createdAt] of Object.entries(registered)) {
    admin.tables.user_events.push({
      id: `reg-${userId}`,
      user_id: userId,
      event: 'registration_completed',
      created_at: createdAt,
      metadata: {},
    });
  }
  const fakeSendEmail = async (payload: any) => {
    mail.push(payload);
    return { sent: true as const, id: `mail-${mail.length}` };
  };
  const run = (now: Date, extra: Record<string, unknown> = {}) => {
    admin.setClock(() => now);
    return runStageFollowups({
      admin,
      now,
      config: { steps: approvedSteps, cohortStart: COHORT },
      deps: { sendDeps: { sendEmail: fakeSendEmail as any, emailConfigured: () => true } },
      ...extra,
    });
  };
  return { admin, mail, run, fakeSendEmail };
}

test('a test account walks every stage and receives exactly the right message each time', async () => {
  const { admin, mail, run } = setup();
  const sentKeys = () =>
    admin.tables.message_log.filter((r: any) => r.user_id === TESTER && r.status === 'sent').map((r: any) => r.template);

  // Day 0, 10:30: 30 minutes after registering. Nothing yet.
  await run(at(0, '10:30'));
  assert.deepEqual(sentKeys(), []);

  // Day 0, 11:05: one hour passed. First "registered" reminder.
  await run(at(0, '11:05'));
  assert.deepEqual(sentKeys(), ['registered_1h']);
  assert.equal(mail.length, 1);
  assert.equal(mail[0]!.to, 'tester@example.com');
  assert.match(mail[0]!.html, /onboarding\/connect/);
  assert.match(mail[0]!.html, /سلمان/);

  // Running again at the same moment must not send twice.
  await run(at(0, '11:05'));
  assert.equal(mail.length, 1);

  // Day 1, 10:30: the 1-day step is due, but the last email was only 23h25m ago.
  await run(at(1, '10:30'));
  assert.deepEqual(sentKeys(), ['registered_1h']);

  // Day 1, 11:10: more than 24 hours since the last one.
  await run(at(1, '11:10'));
  assert.deepEqual(sentKeys(), ['registered_1h', 'registered_1d']);

  // Day 1, 12:00: the user connects an ads account. Stage advances.
  await recordUserEvent(TESTER, 'ads_account_connected', { admin, occurredAt: at(1, '12:00') });
  assert.equal(testerRow(admin).stage, 'connected');

  // Day 1, 12:20: connected_15m is due but today's one message is already used.
  await run(at(1, '12:20'));
  assert.deepEqual(sentKeys(), ['registered_1h', 'registered_1d']);

  // Day 2, 11:15: the allowed window reopens. The "connected" message goes out,
  // and the old stage's third reminder never does.
  await run(at(2, '11:15'));
  assert.deepEqual(sentKeys(), ['registered_1h', 'registered_1d', 'connected_15m']);
  assert.match(mail[2]!.html, /\/audit/);

  // Day 2, 12:00: the user opens the analysis.
  await recordUserEvent(TESTER, 'first_analysis_viewed', { admin, occurredAt: at(2, '12:00') });
  assert.equal(testerRow(admin).stage, 'analysis_viewed');

  // Day 3, 12:05: one day after viewing. connected_1d is NOT sent: the user left that stage.
  await run(at(3, '12:05'));
  assert.deepEqual(sentKeys(), ['registered_1h', 'registered_1d', 'connected_15m', 'analysis_viewed_1d']);
  assert.match(mail[3]!.html, /billing/);

  // Day 5, 12:10: three days after viewing, last step.
  await run(at(5, '12:10'));
  assert.deepEqual(sentKeys(), ['registered_1h', 'registered_1d', 'connected_15m', 'analysis_viewed_1d', 'analysis_viewed_3d']);

  // Later runs send nothing more.
  await run(at(9, '12:00'));
  assert.equal(sentKeys().length, 5);

  // Payment moves the stage to subscribed, and subscribed has no follow-ups.
  await recordUserEvent(TESTER, 'subscription_paid', { admin, occurredAt: at(9, '13:00') });
  assert.equal(testerRow(admin).stage, 'subscribed');
  await run(at(19, '12:00'));
  assert.equal(sentKeys().length, 5);

  // The stage never went backwards, even when an earlier event is recorded late.
  await recordUserEvent(TESTER, 'ads_account_connected', { admin, occurredAt: at(20, '12:00') });
  assert.equal(testerRow(admin).stage, 'subscribed');

  // At most one message per person per 24 hours, across the whole journey.
  const times = admin.tables.message_log
    .filter((r: any) => r.user_id === TESTER && r.status === 'sent')
    .map((r: any) => Date.parse(r.sent_at))
    .sort((a: number, b: number) => a - b);
  for (let i = 1; i < times.length; i += 1) {
    assert.ok(times[i] - times[i - 1] >= 24 * 60 * 60 * 1000, `messages ${i - 1} and ${i} are closer than a day`);
  }

  // The three people who must never be messaged got nothing.
  const everyone = new Set(mail.map((m) => m.to));
  assert.deepEqual([...everyone], ['tester@example.com']);
});

test('every follow-up carries a working opt-out link and the one-click header', async () => {
  const { mail, run } = setup();
  await run(at(0, '11:05'));
  assert.equal(mail.length, 1);
  const header = mail[0]!.headers?.['List-Unsubscribe'] ?? '';
  const url = new URL(header.replace(/^<|>$/g, ''));
  assert.equal(url.pathname, '/api/messages/opt-out');
  assert.equal(verifyOptOutToken(url.searchParams.get('u'), url.searchParams.get('t')), true);
  assert.equal(verifyOptOutToken('someone-else', url.searchParams.get('t')), false);
  assert.match(mail[0]!.footer ?? '', /opt-out/);
  assert.equal(mail[0]!.headers?.['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
});

test('opting out between runs stops the next message', async () => {
  const { admin, mail, run } = setup();
  await run(at(0, '11:05'));
  assert.equal(mail.length, 1);
  testerRow(admin).messages_opt_out = true;
  await run(at(1, '11:30'));
  assert.equal(mail.length, 1);
});

test('a dry run reports the plan and changes nothing', async () => {
  const { admin, mail, run } = setup();
  const summary = await run(at(0, '11:05'), { dryRun: true });
  assert.deepEqual(summary.planned.map((p) => `${p.userId}:${p.stepKey}`), [`${TESTER}:registered_1h`]);
  assert.equal(mail.length, 0);
  assert.equal(admin.tables.message_log.length, 0);
});

test('steps not approved yet send nothing even when everything else is switched on', async () => {
  const { mail, run } = setup();
  await run(at(5, '12:00'), { config: { steps: STAGE_FOLLOWUP_STEPS, cohortStart: COHORT } });
  assert.equal(mail.length, 0);
});

test('without the opt-out signing key nothing is sent and nothing is claimed', async () => {
  const { admin, mail, run } = setup();
  delete process.env.UNSUBSCRIBE_SECRET;
  delete process.env.CRON_SECRET;
  const summary = await run(at(0, '11:05'));
  assert.equal(mail.length, 0);
  const tester = summary.results.find((r) => r.userId === TESTER);
  assert.equal(tester?.result, 'failed:unsubscribe_secret_missing');
  assert.equal(admin.tables.message_log.length, 0);
});

test('a welcome email sent an hour ago holds the first reminder back, and nothing is lost', async () => {
  const { admin, mail, run } = setup();
  admin.tables.message_log.push({
    id: 'w1', user_id: TESTER, channel: 'email', template: 'welcome_ads_connect',
    status: 'sent', attempts: 1, sent_at: at(0, '10:30').toISOString(), updated_at: at(0, '10:30').toISOString(),
  });
  const held = await run(at(0, '11:05'));
  assert.equal(mail.length, 0);
  assert.equal(held.ignored.daily_limit, 1);
  // 24h after the welcome email the reminder is still the one that goes out.
  await run(at(1, '10:45'));
  assert.equal(mail.length, 1);
  assert.match(mail[0]!.html, /onboarding\/connect/);
});

test('send() itself refuses a second message inside 24 hours even if the planner is bypassed', async () => {
  const { admin, mail, fakeSendEmail } = setup();
  admin.tables.message_log.push({
    id: 'w1', user_id: TESTER, channel: 'email', template: 'welcome_ads_connect',
    status: 'sent', attempts: 1, sent_at: at(0, '10:30').toISOString(), updated_at: at(0, '10:30').toISOString(),
  });
  const result = await send(
    'email',
    'registered_1h',
    { id: TESTER, email: 'tester@example.com', name: 'x', messages_opt_out: false },
    { supabase: admin, now: () => at(0, '11:05'), sendEmail: fakeSendEmail as any, emailConfigured: () => true }
  );
  assert.deepEqual(result, { status: 'skipped', reason: 'daily_limit' });
  assert.equal(mail.length, 0);
});

test('only people with a registration_completed event after the cohort start are ever loaded', async () => {
  const { mail, run } = setup();
  const summary = await run(at(5, '12:00'), { dryRun: true });
  // early (before the cohort) is never read, optout is filtered by the flag, old and unconfirmed have no event.
  assert.equal(summary.considered, 1);
  assert.ok(mail.length === 0);
  assert.deepEqual(summary.planned.map((p) => p.userId), [TESTER]);
});

test('a failed send is retried on the next run and then goes out once', async () => {
  const { admin, run } = setup();
  let calls = 0;
  const flaky = async () => {
    calls += 1;
    if (calls === 1) throw new Error('Resend returned 500');
    return { sent: true as const, id: 'ok' };
  };
  const options = { deps: { sendDeps: { sendEmail: flaky as any, emailConfigured: () => true } } };
  const first = await run(at(0, '11:05'), options);
  assert.equal(first.failed, 1);
  const row = () => admin.tables.message_log.find((r: any) => r.user_id === TESTER && r.template === 'registered_1h');
  assert.equal(row()?.status, 'failed');
  await run(at(0, '11:15'), options);
  assert.equal(row()?.status, 'sent');
  assert.equal(row()?.attempts, 2);
  assert.equal(calls, 2);
});
