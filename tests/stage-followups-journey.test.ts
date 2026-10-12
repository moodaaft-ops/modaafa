import assert from 'node:assert/strict';
import test from 'node:test';
import type { FollowupStep } from '../config/stage-followups';
import { STAGE_FOLLOWUP_STEPS } from '../config/stage-followups';
import { send } from '../lib/messaging/send';
import { verifyUnsubscribeToken } from '../lib/messaging/unsubscribe';
import { recordUserEvent } from '../lib/stages/events';
import { runStageFollowups } from '../lib/stages/run-followups';
import { createFakeAdmin } from './support/fake-admin';

const COHORT = '2026-10-12T00:00:00Z';
const at = (day: number, hhmm: string) => new Date(`2026-10-${String(12 + day).padStart(2, '0')}T${hhmm}:00Z`);

const approvedSteps = Object.fromEntries(
  Object.entries(STAGE_FOLLOWUP_STEPS).map(([stage, list]) => [
    stage,
    (list as FollowupStep[]).map((step) => ({ ...step, approved: true })),
  ])
) as typeof STAGE_FOLLOWUP_STEPS;

const testerRow = (admin: { tables: Record<string, any[]> }) => admin.tables.users!.find((u: any) => u.id === 'tester');

function setup() {
  process.env.MESSAGES_UNSUBSCRIBE_SECRET = 'test-unsubscribe-secret';
  const mail: Array<{ to: string; subject: string; html: string; footerHtml?: string; headers?: Record<string, string> }> = [];
  const admin = createFakeAdmin({
    users: [
      { id: 'tester', email: 'tester@example.com', name: 'سلمان العتيبي', stage: 'registered', created_at: at(0, '10:00').toISOString(), messages_opt_out: false },
      { id: 'old', email: 'old@example.com', name: 'قديم', stage: 'registered', created_at: '2026-09-01T10:00:00Z', messages_opt_out: false },
      { id: 'optout', email: 'optout@example.com', name: 'موقف', stage: 'registered', created_at: at(0, '10:00').toISOString(), messages_opt_out: true },
      { id: 'unconfirmed', email: 'unconfirmed@example.com', name: 'ما أكد', stage: 'registered', created_at: at(0, '10:00').toISOString(), messages_opt_out: false },
    ],
  });
  for (const id of ['tester', 'old', 'optout']) admin.confirmEmail(id);
  for (const user of admin.tables.users) {
    admin.tables.user_events.push({
      id: `reg-${user.id}`,
      user_id: user.id,
      event_type: 'registration_completed',
      occurred_at: user.created_at,
      metadata: {},
    });
  }
  const fakeSendEmail = async (payload: any) => {
    mail.push(payload);
    return { sent: true as const, id: `mail-${mail.length}` };
  };
  const run = (now: Date, extra: Record<string, unknown> = {}) =>
    runStageFollowups({
      admin,
      now,
      config: { steps: approvedSteps, cohortStart: COHORT },
      deps: { send: (request) => send(request, { sendEmail: fakeSendEmail as any }) },
      ...extra,
    });
  return { admin, mail, run };
}

test('a test account walks every stage and receives exactly the right message each time', async () => {
  const { admin, mail, run } = setup();
  const sentKeys = () =>
    admin.tables.message_log.filter((r: any) => r.user_id === 'tester' && r.status === 'sent').map((r: any) => r.template_key);

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
  await recordUserEvent('tester', 'ads_account_connected', { admin, occurredAt: at(1, '12:00') });
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
  await recordUserEvent('tester', 'first_analysis_viewed', { admin, occurredAt: at(2, '12:00') });
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
  await recordUserEvent('tester', 'subscription_paid', { admin, occurredAt: at(9, '13:00') });
  assert.equal(testerRow(admin).stage, 'subscribed');
  await run(at(20, '12:00'));
  assert.equal(sentKeys().length, 5);

  // The stage never went backwards, even when an earlier event is recorded late.
  await recordUserEvent('tester', 'ads_account_connected', { admin, occurredAt: at(21, '12:00') });
  assert.equal(testerRow(admin).stage, 'subscribed');

  // At most one message per person per 24 hours, across the whole journey.
  const times = admin.tables.message_log
    .filter((r: any) => r.user_id === 'tester' && r.status === 'sent')
    .map((r: any) => Date.parse(r.sent_at))
    .sort((a: number, b: number) => a - b);
  for (let i = 1; i < times.length; i += 1) {
    assert.ok(times[i] - times[i - 1] >= 24 * 60 * 60 * 1000, `messages ${i - 1} and ${i} are closer than a day`);
  }

  // The three people who must never be messaged got nothing.
  const everyone = new Set(mail.map((m) => m.to));
  assert.deepEqual([...everyone], ['tester@example.com']);
});

test('every follow-up carries a working unsubscribe link and the one-click header', async () => {
  const { mail, run } = setup();
  await run(at(0, '11:05'));
  assert.equal(mail.length, 1);
  const header = mail[0]!.headers?.['List-Unsubscribe'] ?? '';
  const url = new URL(header.replace(/^<|>$/g, ''));
  assert.equal(url.pathname, '/api/messages/unsubscribe');
  assert.equal(verifyUnsubscribeToken(url.searchParams.get('u')!, url.searchParams.get('t')!), true);
  assert.equal(verifyUnsubscribeToken('someone-else', url.searchParams.get('t')!), false);
  assert.match(mail[0]!.footerHtml ?? '', /unsubscribe/);
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
  assert.deepEqual(summary.planned.map((p) => `${p.userId}:${p.stepKey}`), ['tester:registered_1h']);
  assert.equal(summary.ignored.email_unconfirmed, 1);
  assert.equal(mail.length, 0);
  assert.equal(admin.tables.message_log.length, 0);
});

test('steps not approved yet send nothing even when everything else is switched on', async () => {
  const { mail, run } = setup();
  await run(at(5, '12:00'), { config: { steps: STAGE_FOLLOWUP_STEPS, cohortStart: COHORT } });
  assert.equal(mail.length, 0);
});

test('without the unsubscribe secret nothing is sent', async () => {
  const { mail, run } = setup();
  delete process.env.MESSAGES_UNSUBSCRIBE_SECRET;
  const summary = await run(at(0, '11:05'));
  assert.equal(mail.length, 0);
  const tester = summary.results.find((r) => r.userId === 'tester');
  assert.equal(tester?.result, 'skipped:unsubscribe_not_configured');
});

test('a failed send is retried on the next run and then goes out once', async () => {
  const { admin, run } = setup();
  let calls = 0;
  const flaky = async () => {
    calls += 1;
    if (calls === 1) throw new Error('Resend returned 500');
    return { sent: true as const, id: 'ok' };
  };
  const options = { deps: { send: (request: any) => send(request, { sendEmail: flaky as any }) } };
  const first = await run(at(0, '11:05'), options);
  assert.equal(first.failed, 1);
  const row = () => admin.tables.message_log.find((r: any) => r.user_id === 'tester' && r.template_key === 'registered_1h');
  assert.equal(row()?.status, 'failed');
  await run(at(0, '11:15'), options);
  assert.equal(row()?.status, 'sent');
  assert.equal(row()?.attempts, 2);
  assert.equal(calls, 2);
});
