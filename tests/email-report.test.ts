import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  EMAIL_REPORT_HEADER_AR,
  computeEmailReport,
  emailReportRowCells,
  emailReportTotalCells,
  formatLift,
  formatShare,
  groupOf,
  liftPoints,
  type EmailLogRow,
  type EmailReport,
  type EmailReportInput,
  type EmailReportRow,
  type ReportEvent,
  type ReportTrial,
} from '../lib/lifecycle/email-report';
import { loadEmailReport } from '../lib/lifecycle/load-email-report';
import { isHoldout } from '../lib/lifecycle/holdout';
import { REPORT_STEPS, flattenSteps } from '../lib/lifecycle/report-steps';
import { computeFunnel, funnelToCsv } from '../lib/stages/funnel';
import { createFakeAdmin } from './support/fake-admin';

/**
 * Every number below was counted by hand from the fixture before the code was
 * run. The "now" is 30 October and the lifecycle went live on 1 October, so most
 * 7 and 14 day windows are closed and a few are deliberately still open.
 */
const NOW = new Date('2026-10-30T12:00:00Z');
const ACTIVATED = '2026-10-01T00:00:00Z';
const at = (day: string, time = '00:00') => `2026-${day}T${time}:00Z`;

const HOLDOUT_IDS = new Set([
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', // registered / connected journeys
  'HT1', 'HT2', 'HT3', 'HT4', 'HT5', 'HT6', // trial journey
  'HP1', 'HP2', 'HP3', // plan_ready journey (HP1 and HP3 also started a trial)
]);

function sent(userId: string, template: string, sentAt: string | null, extra: Partial<EmailLogRow> = {}): EmailLogRow {
  return {
    userId,
    template,
    copyKey: template,
    status: 'sent',
    sentAt,
    deliveredAt: null,
    openedAt: null,
    clickedAt: null,
    bouncedAt: null,
    complainedAt: null,
    ...extra,
  };
}
const ev = (userId: string, eventType: string, createdAt: string): ReportEvent => ({ userId, eventType, createdAt });
const trial = (userId: string, startedAt: string, endsAt: string, canceledAt: string | null = null): ReportTrial => ({
  userId,
  startedAt,
  endsAt,
  canceledAt,
});

const USER_IDS = [
  'R1', 'R2', 'R3', 'R4', 'R5',
  'W1', 'W2', 'X',
  'T1', 'T2', 'T3', 'T4',
  'P1', 'P2', 'P3', 'P4',
  'Q1', 'Q2',
  ...HOLDOUT_IDS,
];

const LOGS: EmailLogRow[] = [
  // registered_1d: five sent, the fifth with no delivery data at all (a row from before the columns existed)
  sent('R1', 'registered_1d', at('10-05', '10:00'), { deliveredAt: at('10-05', '10:01'), openedAt: at('10-05', '11:00'), clickedAt: at('10-05', '11:02') }),
  sent('R2', 'registered_1d', at('10-05', '12:00'), { deliveredAt: at('10-05', '12:01'), openedAt: at('10-05', '13:00') }),
  sent('R3', 'registered_1d', at('10-06', '09:00'), { deliveredAt: at('10-06', '09:01'), complainedAt: at('10-06', '12:00') }),
  sent('R4', 'registered_1d', at('10-27', '09:00'), { bouncedAt: at('10-27', '09:01') }),
  sent('R5', 'registered_1d', at('10-04', '08:00')),
  sent('R3', 'registered_3d', at('10-09', '09:00'), { deliveredAt: at('10-09', '09:01') }),
  // welcome: everybody gets it, so there is no comparison group
  sent('W1', 'welcome_ads_connect', at('10-01', '10:00'), { deliveredAt: at('10-01', '10:01'), openedAt: at('10-01', '12:00') }),
  sent('W2', 'welcome_ads_connect', at('10-02', '10:00'), { deliveredAt: at('10-02', '10:01') }),
  // trial_d1
  sent('T1', 'trial_d1', at('10-02', '10:00'), { deliveredAt: at('10-02', '10:01'), openedAt: at('10-02', '11:00'), clickedAt: at('10-02', '11:01') }),
  sent('T2', 'trial_d1', at('10-03', '10:00'), { deliveredAt: at('10-03', '10:01') }),
  sent('T3', 'trial_d1', at('10-20', '10:00'), { deliveredAt: at('10-20', '10:01') }),
  sent('T4', 'trial_d1', at('10-01', '10:00'), { deliveredAt: at('10-01', '10:01') }),
  // plan_ready_1d
  sent('P1', 'plan_ready_1d', at('10-05', '10:00'), { deliveredAt: at('10-05', '10:01') }),
  sent('P2', 'plan_ready_1d', at('10-05', '10:00'), { deliveredAt: at('10-05', '10:01') }),
  sent('P3', 'plan_ready_1d', at('10-06', '10:00'), { deliveredAt: at('10-06', '10:01') }),
  sent('P4', 'plan_ready_1d', at('10-06', '10:00'), { deliveredAt: at('10-06', '10:01') }),
  // weekly: three different keys fold into one row, one of them with no copy_key
  sent('Q1', 'weekly_report_2026-W41', at('10-11', '06:00'), { copyKey: 'weekly_report', deliveredAt: at('10-11', '06:01') }),
  sent('Q1', 'weekly_report_2026-W42', at('10-18', '06:00'), { copyKey: null }),
  sent('Q2', 'weekly_report_2026-W42', at('10-18', '06:00'), { copyKey: 'weekly_report', deliveredAt: at('10-18', '06:01') }),
  // other rows
  sent('Q2', 'tx_trial_ending', at('10-12', '08:00')),
  sent('Q2', 'broadcast_chat_relaunch', null), // sent, but no time recorded
  // never counted: not sent
  sent('Q1', 'registered_7d', null, { status: 'failed' }),
  sent('Q1', 'registered_7d', at('10-10', '10:00'), { status: 'skipped' }),
];

const EVENTS: ReportEvent[] = [
  ev('R1', 'ads_account_connected', at('10-07', '09:00')),
  ev('R2', 'ads_account_connected', at('10-13', '09:00')),
  ev('R5', 'ads_account_connected', at('10-03', '09:00')),
  ev('W1', 'ads_account_connected', at('10-03', '09:00')),
  ev('H1', 'registration_completed', at('10-02', '10:00')),
  ev('H1', 'ads_account_connected', at('10-04', '15:00')),
  ev('H2', 'registration_completed', at('10-03', '00:00')),
  ev('H3', 'registration_completed', at('10-04', '12:00')),
  ev('H3', 'ads_account_connected', at('10-05', '08:00')),
  ev('H4', 'registration_completed', at('10-28', '00:00')),
  ev('H5', 'registration_completed', at('09-20', '00:00')),
  ev('T1', 'subscription_paid', at('10-11', '09:00')),
  ev('T4', 'subscription_paid', at('09-30', '09:00')),
  ev('HT1', 'subscription_paid', at('10-14', '09:00')),
  ev('P2', 'subscription_paid', at('10-07', '09:00')),
  ev('HP1', 'first_analysis_viewed', at('10-04', '12:00')),
  ev('HP2', 'first_analysis_viewed', at('10-04', '12:00')),
  ev('HP3', 'first_analysis_viewed', at('10-04', '12:00')),
];

const TRIALS: ReportTrial[] = [
  trial('HT1', at('10-02'), at('10-16')),
  trial('HT2', at('10-03'), at('10-17')),
  trial('HT3', at('10-05'), at('10-19'), at('10-07')),
  trial('HT4', at('09-25'), at('10-09')),
  trial('HT5', at('10-02'), at('10-05', '12:00')),
  trial('HT6', at('10-27'), at('11-10')),
  trial('P1', at('10-06'), at('10-20')),
  trial('P4', at('10-20'), at('11-03')),
  trial('HP1', at('10-08'), at('10-22')),
  trial('HP3', at('10-04', '18:00'), at('10-18')),
];

const OPT_OUTS = [
  { userId: 'R2', at: at('10-06') }, // 12 hours after registered_1d
  { userId: 'R3', at: at('10-10', '10:00') }, // last mail was registered_3d, not registered_1d
  { userId: 'R5', at: at('10-30', '09:00') }, // 26 days after the only mail: too late to blame it
  { userId: 'T2', at: at('10-04', '10:00') }, // a day after trial_d1
  { userId: 'X', at: at('10-15') }, // never mailed
];

function input(overrides: Partial<EmailReportInput> = {}): EmailReportInput {
  return {
    now: NOW,
    logs: LOGS,
    userIds: USER_IDS,
    optOuts: OPT_OUTS,
    events: EVENTS,
    trials: TRIALS,
    steps: REPORT_STEPS,
    activatedAt: ACTIVATED,
    holdoutPercent: 10,
    isHoldout: (id) => HOLDOUT_IDS.has(id),
    engagementTracked: true,
    ...overrides,
  };
}

const rowOf = (report: EmailReport, group: string): EmailReportRow => {
  const row = report.rows.find((candidate) => candidate.group === group);
  assert.ok(row, `row ${group} exists`);
  return row;
};

const counts = (row: EmailReportRow) => ({
  sent: row.sent,
  delivered: row.delivered,
  opened: row.opened,
  clicked: row.clicked,
  optOuts: row.optOuts,
  bounced: row.bounced,
  complained: row.complained,
});

// ---------------------------------------------------------------------------
// Counts per template
// ---------------------------------------------------------------------------

test('rows come in the order of the copy keys, one per configured step plus the rows that were sent', () => {
  const report = computeEmailReport(input());
  assert.deepEqual(report.rows.map((row) => row.group), [
    'welcome_ads_connect',
    'registered_1d', 'registered_3d', 'registered_7d',
    'connected_3h', 'connected_1d',
    'plan_ready_1d', 'plan_ready_3d', 'plan_ready_7d',
    'trial_d1', 'trial_d4', 'trial_d9',
    'trial_lapsed_2d', 'trial_lapsed_14d',
    'canceled_1d', 'canceled_30d',
    'past_due_3d',
    'weekly_report',
    'tx_trial_ending',
    'broadcast_chat_relaunch',
  ]);
});

test('sent, delivered, opened, clicked, bounced, complained and opt-outs match the hand count', () => {
  const report = computeEmailReport(input());
  assert.deepEqual(counts(rowOf(report, 'registered_1d')), {
    sent: 5, delivered: 3, opened: 2, clicked: 1, optOuts: 1, bounced: 1, complained: 1,
  });
  assert.deepEqual(counts(rowOf(report, 'registered_3d')), {
    sent: 1, delivered: 1, opened: 0, clicked: 0, optOuts: 1, bounced: 0, complained: 0,
  });
  assert.deepEqual(counts(rowOf(report, 'welcome_ads_connect')), {
    sent: 2, delivered: 2, opened: 1, clicked: 0, optOuts: 0, bounced: 0, complained: 0,
  });
  assert.deepEqual(counts(rowOf(report, 'trial_d1')), {
    sent: 4, delivered: 4, opened: 1, clicked: 1, optOuts: 1, bounced: 0, complained: 0,
  });
  assert.deepEqual(counts(rowOf(report, 'plan_ready_1d')), {
    sent: 4, delivered: 4, opened: 0, clicked: 0, optOuts: 0, bounced: 0, complained: 0,
  });
});

test('weekly mails fold into one row whether or not copy_key was written', () => {
  const row = rowOf(computeEmailReport(input()), 'weekly_report');
  assert.deepEqual(counts(row), { sent: 3, delivered: 2, opened: 0, clicked: 0, optOuts: 0, bounced: 0, complained: 0 });
  assert.equal(row.next, null);
});

test('failed and skipped rows are not counted, and a sent row with no time still is', () => {
  const report = computeEmailReport(input());
  assert.equal(rowOf(report, 'registered_7d').sent, 0);
  assert.equal(rowOf(report, 'broadcast_chat_relaunch').sent, 1);
  assert.equal(rowOf(report, 'tx_trial_ending').sent, 1);
});

test('totals add up the rows: 21 sent, 16 delivered, 4 opened, 2 clicked, 3 opt-outs', () => {
  const { totals } = computeEmailReport(input());
  assert.deepEqual(totals, { sent: 21, delivered: 16, opened: 4, clicked: 2, optOuts: 3, bounced: 1, complained: 1 });
});

test('an opt-out is blamed on the last mail before it, and only inside seven days', () => {
  const report = computeEmailReport(input());
  assert.equal(rowOf(report, 'registered_1d').optOuts, 1); // R2 only; R3 moved to registered_3d, R5 was too late, X got nothing
  assert.equal(rowOf(report, 'registered_3d').optOuts, 1);
  assert.equal(rowOf(report, 'trial_d1').optOuts, 1);
});

// ---------------------------------------------------------------------------
// Reached the next stage: recipients against the comparison group
// ---------------------------------------------------------------------------

test('registered_1d: 1 of 3 recipients connected, 1 of 2 comparison users did', () => {
  const next = rowOf(computeEmailReport(input()), 'registered_1d').next;
  assert.ok(next);
  assert.equal(next.targetLabel, 'ربطوا الحساب');
  assert.equal(next.windowDays, 7);
  // R1 hit, R2 missed (connected on day 8), R3 missed, R4 still inside its window, R5 had already connected.
  assert.deepEqual(next.recipients, { eligible: 3, reached: 1 });
  // H1 hit, H2 missed, H3 had connected before the mail was due, H4 still inside its window, H5 due before launch, H6 never registered.
  assert.deepEqual(next.holdout, { eligible: 2, reached: 1 });
  assert.equal(liftPoints(next.recipients, next.holdout), -16.7);
  assert.equal(formatLift(-16.7), '16.7 نقطة أقل');
});

test('registered_3d and registered_7d only count comparison users whose window has closed', () => {
  const report = computeEmailReport(input());
  const third = rowOf(report, 'registered_3d').next;
  assert.deepEqual(third?.recipients, { eligible: 1, reached: 0 });
  assert.deepEqual(third?.holdout, { eligible: 1, reached: 0 });
  assert.equal(formatLift(liftPoints(third!.recipients, third!.holdout)), 'بدون فرق');
  const seventh = rowOf(report, 'registered_7d').next;
  assert.deepEqual(seventh?.recipients, { eligible: 0, reached: 0 });
  assert.deepEqual(seventh?.holdout, { eligible: 1, reached: 0 });
  assert.equal(liftPoints(seventh!.recipients, seventh!.holdout), null);
});

test('connected journey: comparison users who connected and never viewed the analysis', () => {
  const report = computeEmailReport(input());
  assert.deepEqual(rowOf(report, 'connected_3h').next?.holdout, { eligible: 2, reached: 0 });
  assert.deepEqual(rowOf(report, 'connected_1d').next?.holdout, { eligible: 2, reached: 0 });
  assert.equal(rowOf(report, 'connected_3h').next?.targetLabel, 'شافوا التحليل');
});

test('the welcome mail has a next stage but no comparison group', () => {
  const next = rowOf(computeEmailReport(input()), 'welcome_ads_connect').next;
  assert.ok(next);
  assert.deepEqual(next.recipients, { eligible: 2, reached: 1 }); // W1 connected on day 2, W2 never
  assert.equal(next.holdout, null);
});

test('trial_d1: paying within 14 days, recipients against comparison users who were trialing at the time', () => {
  const next = rowOf(computeEmailReport(input()), 'trial_d1').next;
  assert.ok(next);
  assert.equal(next.windowDays, 14);
  assert.equal(next.targetLabel, 'دفعوا الاشتراك');
  // T1 paid on day 9, T2 never, T3 still inside its window, T4 had paid before the mail.
  assert.deepEqual(next.recipients, { eligible: 2, reached: 1 });
  // HT1 paid, HT2 / HT3 / HT5 / HP1 / HP3 did not, HT4 started before launch, HT6 still inside its window.
  assert.deepEqual(next.holdout, { eligible: 6, reached: 1 });
  assert.equal(formatLift(liftPoints(next.recipients, next.holdout)), '33.3 نقطة أعلى');
});

test('trial_d4 and trial_d9 skip comparison users whose trial had ended or been cancelled by the due time', () => {
  const report = computeEmailReport(input());
  // d4: HT1 paid, HT2 / HP1 / HP3 did not. HT3 cancelled, HT4 due before launch, HT5 trial ended, HT6 still open.
  assert.deepEqual(rowOf(report, 'trial_d4').next?.holdout, { eligible: 4, reached: 1 });
  // d9: HT1 paid, HT2 / HT4 / HP3 did not. HT3 cancelled, HT5 ended, HT6 and HP1 still open.
  assert.deepEqual(rowOf(report, 'trial_d9').next?.holdout, { eligible: 4, reached: 1 });
});

test('plan_ready: starting the trial counts as reaching the goal, and so does paying without one', () => {
  const report = computeEmailReport(input());
  const first = rowOf(report, 'plan_ready_1d').next;
  assert.ok(first);
  assert.equal(first.targetLabel, 'بدؤوا التجربة أو دفعوا');
  // P1 started a trial on day 1, P2 paid, P3 nothing, P4 started its trial on day 14.
  assert.deepEqual(first.recipients, { eligible: 4, reached: 2 });
  // HP1 started a trial in time, HP2 nothing, HP3 had started before the mail was due.
  assert.deepEqual(first.holdout, { eligible: 2, reached: 1 });
  assert.equal(formatLift(liftPoints(first.recipients, first.holdout)), 'بدون فرق');
  assert.deepEqual(rowOf(report, 'plan_ready_3d').next?.holdout, { eligible: 2, reached: 1 });
  assert.deepEqual(rowOf(report, 'plan_ready_7d').next?.holdout, { eligible: 1, reached: 0 });
});

test('journeys with no funnel stage to aim at say so instead of inventing a goal', () => {
  const report = computeEmailReport(input());
  for (const group of ['trial_lapsed_2d', 'trial_lapsed_14d', 'canceled_1d', 'canceled_30d', 'past_due_3d', 'weekly_report', 'tx_trial_ending']) {
    assert.equal(rowOf(report, group).next, null, group);
  }
});

test('the comparison group size is the number the hash picked', () => {
  const { holdout } = computeEmailReport(input());
  assert.deepEqual(holdout, { users: 15, total: 33, percent: 10 });
});

// ---------------------------------------------------------------------------
// Missing data
// ---------------------------------------------------------------------------

test('no go-live date means no comparison at all, but recipients are still counted', () => {
  const report = computeEmailReport(input({ activatedAt: null }));
  const next = rowOf(report, 'registered_1d').next;
  assert.deepEqual(next?.recipients, { eligible: 3, reached: 1 });
  assert.deepEqual(next?.holdout, { eligible: 0, reached: 0 });
  assert.equal(formatLift(liftPoints(next!.recipients, next!.holdout)), 'لا يوجد');
  assert.equal(emailReportRowCells(rowOf(report, 'registered_1d'))[18], 'لا يوجد');
});

test('when trials could not be read the trial and plan_ready numbers are left out, the rest stay', () => {
  const report = computeEmailReport(input({ trials: null }));
  for (const group of ['trial_d1', 'trial_d4', 'trial_d9', 'plan_ready_1d', 'plan_ready_3d', 'plan_ready_7d']) {
    assert.equal(rowOf(report, group).next, null, group);
  }
  assert.deepEqual(rowOf(report, 'registered_1d').next?.recipients, { eligible: 3, reached: 1 });
  assert.deepEqual(rowOf(report, 'connected_3h').next?.holdout, { eligible: 2, reached: 0 });
});

test('with nothing at all there are zero rows of numbers and no NaN, Infinity or crash', () => {
  const report = computeEmailReport(
    input({ logs: [], userIds: [], optOuts: [], events: [], trials: [], isHoldout: () => false })
  );
  assert.equal(report.rows.length, 18); // 16 configured steps, the welcome mail and the weekly report
  assert.deepEqual(report.totals, { sent: 0, delivered: 0, opened: 0, clicked: 0, optOuts: 0, bounced: 0, complained: 0 });
  assert.deepEqual(report.holdout, { users: 0, total: 0, percent: 10 });
  const text = [...report.rows.flatMap((row) => emailReportRowCells(row)), ...emailReportTotalCells(report)].join('|');
  assert.ok(!/NaN|Infinity|undefined|null/.test(text));
  assert.equal(emailReportRowCells(report.rows[1])[3], 'لا يوجد'); // delivered share of zero sent
});

test('rows with every optional field null do not crash and count only as sent', () => {
  const bare: EmailLogRow = {
    userId: 'R9', template: 'registered_1d', copyKey: null, status: 'sent', sentAt: 'not a date',
    deliveredAt: null, openedAt: null, clickedAt: null, bouncedAt: null, complainedAt: null,
  };
  const report = computeEmailReport(input({ logs: [bare], optOuts: [{ userId: 'R9', at: 'also not a date' }] }));
  assert.deepEqual(counts(rowOf(report, 'registered_1d')), {
    sent: 1, delivered: 0, opened: 0, clicked: 0, optOuts: 0, bounced: 0, complained: 0,
  });
  assert.deepEqual(rowOf(report, 'registered_1d').next?.recipients, { eligible: 0, reached: 0 });
});

test('before the delivery columns exist the engagement cells say غير متاح instead of zero', () => {
  const report = computeEmailReport(input({ engagementTracked: false }));
  const cells = emailReportRowCells(rowOf(report, 'registered_1d'), report.engagementTracked);
  assert.deepEqual(cells.slice(1, 11), [5, 'غير متاح', 'غير متاح', 'غير متاح', 'غير متاح', 'غير متاح', 'غير متاح', 1, 'غير متاح', 'غير متاح']);
  assert.equal(emailReportTotalCells(report)[2], 'غير متاح');
});

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

test('shares and lifts never divide by zero and use Latin digits', () => {
  assert.equal(formatShare(0, 0), 'لا يوجد');
  assert.equal(formatShare(1, 3), '33.3%');
  assert.equal(formatShare(5, 5), '100%');
  assert.equal(formatLift(null), 'لا يوجد');
  assert.equal(formatLift(0), 'بدون فرق');
  assert.equal(formatLift(25), '25 نقطة أعلى');
  assert.equal(liftPoints({ eligible: 0, reached: 0 }, { eligible: 3, reached: 1 }), null);
  assert.equal(liftPoints({ eligible: 3, reached: 1 }, null), null);
  assert.ok(!/[٠-٩]/.test(formatShare(2, 3) + formatLift(12.5)));
});

test('groupOf folds weekly keys and trusts a matching copy_key', () => {
  assert.equal(groupOf('weekly_report_2026-W41', null), 'weekly_report');
  assert.equal(groupOf('weekly_report_2026-W41', 'weekly_report'), 'weekly_report');
  assert.equal(groupOf('registered_3d', 'registered_3d'), 'registered_3d');
  assert.equal(groupOf('registered_3d', null), 'registered_3d');
  assert.equal(groupOf('old_followup_key', null), 'old_followup_key');
});

test('isHoldout is stable and agrees with an independent sha256 calculation', () => {
  // Buckets computed outside this codebase: sha256(id), first four bytes big-endian, modulo 100.
  assert.equal(isHoldout('user-2'), true); // bucket 7
  assert.equal(isHoldout('user-2', 7), false);
  assert.equal(isHoldout('user-2', 8), true);
  assert.equal(isHoldout('user-1'), false); // bucket 52
  assert.equal(isHoldout('user-1', 52), false);
  assert.equal(isHoldout('user-1', 53), true);
  assert.equal(isHoldout('00000000-0000-0000-0000-000000000001'), false); // bucket 19
  assert.equal(isHoldout('anyone', 0), false);
  assert.equal(isHoldout('anyone', 100), true);
  let inside = 0;
  for (let i = 0; i < 5000; i += 1) if (isHoldout(`person-${i}`)) inside += 1;
  assert.ok(inside > 400 && inside < 600, `about 10% of 5000, got ${inside}`);
});

// ---------------------------------------------------------------------------
// The CSV
// ---------------------------------------------------------------------------

const FUNNEL_NOW = new Date('2026-10-12T12:00:00Z');
const FUNNEL = computeFunnel({
  users: [
    { id: 'A', stage: 'registered', createdAt: '2026-09-22T00:00:00Z' },
    { id: 'B', stage: 'connected', createdAt: '2026-10-02T00:00:00Z' },
  ],
  events: [{ userId: 'B', eventType: 'ads_account_connected' }],
  now: FUNNEL_NOW,
});

test('without an email report the stage CSV is exactly what it was: BOM, header, four stages', () => {
  const csv = funnelToCsv(FUNNEL);
  assert.ok(csv.startsWith('﻿'));
  assert.equal(csv.trim().split('\r\n').length, 5);
});

test('with an email report the CSV keeps the BOM and adds a blank line, a title, a header, every row and a total', () => {
  const email = computeEmailReport(input());
  const csv = funnelToCsv(FUNNEL, email);
  assert.ok(csv.startsWith('﻿'));
  const lines = csv.trim().split('\r\n');
  assert.equal(lines.length, 5 + 1 + 1 + 1 + email.rows.length + 1);
  assert.equal(lines[5], '');
  assert.equal(lines[6], 'رسائل البريد');
  assert.equal(lines[7], EMAIL_REPORT_HEADER_AR.join(','));
  assert.ok(lines[8].startsWith('الترحيب بعد التسجيل,2,2,100%,1,50%,0,0%,0,0,0,ربطوا الحساب,7,2,1,50%,'));
  assert.ok(lines[lines.length - 1].startsWith('المجموع,21,16,76.2%,4,19%,2,9.5%,3,1,1'));
  // The columns line up: every row has as many cells as the header.
  for (const line of lines.slice(8)) assert.equal(line.split(',').length, EMAIL_REPORT_HEADER_AR.length, line);
  assert.ok(!/[٠-٩]/.test(csv), 'Latin digits only');
  assert.ok(!csv.includes("'"), 'nothing was escaped as a formula');
});

test('the registered_1d CSV row carries the same numbers as the hand count', () => {
  const email = computeEmailReport(input());
  const lines = funnelToCsv(FUNNEL, email).trim().split('\r\n');
  const row = lines.find((line) => line.startsWith('سجّل وما ربط، بعد يوم'));
  assert.equal(
    row,
    // The label has an Arabic comma, which is not a CSV separator, so the cell is not quoted.
    'سجّل وما ربط، بعد يوم,5,3,60%,2,40%,1,20%,1,1,1,ربطوا الحساب,7,3,1,33.3%,2,1,50%,16.7 نقطة أقل'
  );
});

test('when the email numbers could not be read the CSV says so in one line', () => {
  const lines = funnelToCsv(FUNNEL, null, 'تعذر قراءة أرقام رسائل البريد').trim().split('\r\n');
  assert.equal(lines.length, 7);
  assert.equal(lines[5], '');
  assert.equal(lines[6], 'تعذر قراءة أرقام رسائل البريد');
});

// ---------------------------------------------------------------------------
// The loader, against an in-memory database
// ---------------------------------------------------------------------------

function seededAdmin() {
  return createFakeAdmin({
    users: [
      { id: 'U1', created_at: at('09-01'), messages_opt_out_at: null },
      { id: 'U2', created_at: at('09-02'), messages_opt_out_at: at('10-06') },
      { id: 'U3', created_at: at('09-03'), messages_opt_out_at: null },
    ],
    message_log: [
      { id: 'm1', user_id: 'U1', channel: 'email', template: 'registered_1d', copy_key: 'registered_1d', status: 'sent', sent_at: at('10-05', '12:00'), created_at: at('10-05', '12:00'), delivered_at: at('10-05', '12:01'), opened_at: at('10-05', '13:00'), clicked_at: null, bounced_at: null, complained_at: null },
      { id: 'm2', user_id: 'U2', channel: 'email', template: 'registered_1d', copy_key: null, status: 'sent', sent_at: at('10-05', '12:00'), created_at: at('10-05', '12:01') },
      { id: 'm3', user_id: 'U3', channel: 'email', template: 'registered_1d', status: 'failed', sent_at: null, created_at: at('10-05', '12:02') },
      { id: 'm4', user_id: 'U3', channel: 'whatsapp', template: 'registered_1d', status: 'sent', sent_at: at('10-05', '12:03'), created_at: at('10-05', '12:03') },
    ],
    user_events: [
      { id: 'e1', user_id: 'U1', event: 'ads_account_connected', created_at: at('10-07') },
      { id: 'e2', user_id: 'U1', event: 'welcome_email_sent', created_at: at('09-01') },
    ],
    subscriptions: [
      { id: 's1', user_id: 'U3', created_at: at('10-03'), trial_ends_at: at('10-17'), canceled_at: null },
      { id: 's2', user_id: 'U1', created_at: at('10-01'), trial_ends_at: null, canceled_at: null },
    ],
  });
}

const CONFIG = { steps: REPORT_STEPS, activatedAt: ACTIVATED, holdoutPercent: 10 };

test('the loader reads email rows only, folds nulls, and attributes the opt-out', async () => {
  const report = await loadEmailReport(seededAdmin(), NOW, CONFIG);
  const row = rowOf(report, 'registered_1d');
  // U1 delivered and opened; U2 has a null copy_key and no delivery data; the failed row and the WhatsApp row are not email sent.
  assert.deepEqual(counts(row), { sent: 2, delivered: 1, opened: 1, clicked: 0, optOuts: 1, bounced: 0, complained: 0 });
  // U1 connected on day 2 (hit), U2 never did (miss).
  assert.deepEqual(row.next?.recipients, { eligible: 2, reached: 1 });
  assert.equal(report.engagementTracked, true);
  assert.equal(report.holdout.total, 3);
});

test('when message_log has no delivery columns yet the loader falls back and flags it', async () => {
  const admin = seededAdmin();
  const failing = {
    eq: () => failing,
    order: () => failing,
    range: () =>
      Promise.resolve({ data: null, error: { code: '42703', message: 'column message_log.copy_key does not exist' } }),
  };
  const withoutColumns = {
    ...admin,
    from(table: string) {
      if (table !== 'message_log') return admin.from(table);
      return { select: (columns: string) => (columns.includes('opened_at') ? failing : (admin.from(table) as any).select(columns)) };
    },
  };
  const report = await loadEmailReport(withoutColumns, NOW, CONFIG);
  assert.equal(report.engagementTracked, false);
  assert.equal(rowOf(report, 'registered_1d').sent, 2);
  // (The in-memory database returns whole rows, so the count itself is not asserted: what the page shows is.)
  assert.equal(emailReportRowCells(rowOf(report, 'registered_1d'), report.engagementTracked)[2], 'غير متاح');
});

test('a failing trials read leaves the trial numbers out and keeps the rest', async () => {
  const admin = seededAdmin();
  const withoutTrials = {
    ...admin,
    from(table: string) {
      if (table !== 'subscriptions') return admin.from(table);
      throw new Error('boom');
    },
  };
  const original = console.error;
  console.error = () => {};
  try {
    const report = await loadEmailReport(withoutTrials, NOW, CONFIG);
    assert.equal(rowOf(report, 'trial_d1').next, null);
    assert.equal(rowOf(report, 'plan_ready_1d').next, null);
    assert.equal(rowOf(report, 'registered_1d').sent, 2);
  } finally {
    console.error = original;
  }
});

test('a failing message_log read is an error, not an empty report', async () => {
  const admin = seededAdmin();
  const broken = {
    ...admin,
    from(table: string) {
      if (table !== 'message_log') return admin.from(table);
      const failing = {
        eq: () => failing,
        order: () => failing,
        range: () => Promise.resolve({ data: null, error: { code: '42P01', message: 'relation does not exist' } }),
      };
      return { select: () => failing };
    },
  };
  await assert.rejects(() => loadEmailReport(broken, NOW, CONFIG), /message_log/);
});

// ---------------------------------------------------------------------------
// The mirror of the engine's schedule
// ---------------------------------------------------------------------------

test('report-steps.ts agrees with config/email-journeys.ts once that file exists', async (t) => {
  const file = path.join(process.cwd(), 'config', 'email-journeys.ts');
  if (!existsSync(file)) {
    t.skip('config/email-journeys.ts is not in this branch yet; swap report-steps.ts for the config and delete this guard');
    return;
  }
  const specifier = '../config/email-journeys';
  const config = (await import(specifier)) as {
    JOURNEY_STEPS: Parameters<typeof flattenSteps>[0];
    EMAIL_LIFECYCLE_ACTIVATED_AT: string | null;
    HOLDOUT_PERCENT: number;
  };
  const { REPORT_ACTIVATED_AT, REPORT_HOLDOUT_PERCENT } = await import('../lib/lifecycle/report-steps');
  assert.deepEqual(REPORT_STEPS, flattenSteps(config.JOURNEY_STEPS));
  assert.equal(REPORT_ACTIVATED_AT, config.EMAIL_LIFECYCLE_ACTIVATED_AT);
  assert.equal(REPORT_HOLDOUT_PERCENT, config.HOLDOUT_PERCENT);
});
