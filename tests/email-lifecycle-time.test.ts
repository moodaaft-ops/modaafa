import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { HOLDOUT_PERCENT } from '../config/email-journeys';
import { isHoldout } from '../lib/lifecycle/holdout';
import {
  isInSendWindow,
  isoWeekOf,
  riyadhHour,
  riyadhWeekday,
  weeklyReportSlot,
} from '../lib/lifecycle/riyadh';
import { riyadh } from './support/lifecycle';

test('Riyadh is UTC+3 all year: the hour and weekday follow the fixed offset', () => {
  assert.equal(riyadhHour(new Date('2026-10-14T06:00:00Z')), 9);
  assert.equal(riyadhHour(new Date('2026-07-01T06:00:00Z')), 9, 'no daylight saving in summer');
  assert.equal(riyadhHour(new Date('2026-01-01T06:00:00Z')), 9, 'nor in winter');
  // 21:30 UTC is already the next calendar day in Riyadh.
  assert.equal(riyadhHour(new Date('2026-10-14T21:30:00Z')), 0);
  assert.equal(riyadhWeekday(new Date('2026-10-17T21:30:00Z')), 0, 'Saturday 21:30 UTC is Sunday 00:30 in Riyadh');
  assert.equal(riyadhWeekday(new Date('2026-10-17T20:59:00Z')), 6);
});

test('the send window is [09:00, 22:00) Riyadh: 08:59 out, 09:00 in, 20:59 in, 21:59 in, 22:00 out', () => {
  assert.equal(isInSendWindow(riyadh('2026-10-14T08:59')), false);
  assert.equal(isInSendWindow(riyadh('2026-10-14T09:00')), true);
  assert.equal(isInSendWindow(riyadh('2026-10-14T20:59')), true);
  assert.equal(isInSendWindow(riyadh('2026-10-14T21:59')), true);
  assert.equal(isInSendWindow(riyadh('2026-10-14T22:00')), false);
});

test('the send window holds across midnight in Riyadh, where the UTC date differs', () => {
  assert.equal(isInSendWindow(new Date('2026-10-14T21:00:00Z')), false, '00:00 Riyadh on the 15th');
  assert.equal(isInSendWindow(new Date('2026-10-14T23:30:00Z')), false, '02:30 Riyadh');
  assert.equal(isInSendWindow(new Date('2026-10-15T05:59:00Z')), false, '08:59 Riyadh');
  assert.equal(isInSendWindow(new Date('2026-10-15T06:00:00Z')), true, '09:00 Riyadh');
  assert.equal(isInSendWindow(new Date('2026-10-14T18:59:00Z')), true, '21:59 Riyadh on the 14th');
  assert.equal(isInSendWindow(new Date('2026-10-14T19:00:00Z')), false, '22:00 Riyadh on the 14th');
});

test('ISO week numbers, including the year boundaries', () => {
  assert.deepEqual(isoWeekOf(2026, 10, 18), { isoYear: 2026, week: 42 }); // a Sunday
  assert.deepEqual(isoWeekOf(2026, 10, 12), { isoYear: 2026, week: 42 }); // the Monday of that week
  assert.deepEqual(isoWeekOf(2026, 10, 19), { isoYear: 2026, week: 43 });
  assert.deepEqual(isoWeekOf(2026, 1, 1), { isoYear: 2026, week: 1 });
  assert.deepEqual(isoWeekOf(2027, 1, 3), { isoYear: 2026, week: 53 }); // Sunday still in 2026's last week
  assert.deepEqual(isoWeekOf(2027, 1, 4), { isoYear: 2027, week: 1 });
  assert.deepEqual(isoWeekOf(2024, 12, 29), { isoYear: 2024, week: 52 });
  assert.deepEqual(isoWeekOf(2024, 12, 30), { isoYear: 2025, week: 1 });
  assert.deepEqual(isoWeekOf(2021, 1, 3), { isoYear: 2020, week: 53 });
});

test('weekly slot: Saturday night and Sunday 08:59 have none, Sunday 09:00 opens it', () => {
  assert.equal(weeklyReportSlot(riyadh('2026-10-17T23:00')), null, 'Saturday night');
  assert.equal(weeklyReportSlot(riyadh('2026-10-18T00:30')), null, 'just after midnight, Sunday');
  assert.equal(weeklyReportSlot(riyadh('2026-10-18T08:59')), null, 'one minute early');

  const slot = weeklyReportSlot(riyadh('2026-10-18T09:00'));
  assert.ok(slot);
  assert.equal(slot.templateKey, 'weekly_report_2026-W42');
  assert.equal(slot.dueAt.toISOString(), '2026-10-18T06:00:00.000Z');
  assert.equal(slot.expiresAt.toISOString(), '2026-10-20T18:00:00.000Z', '60 hours later, Tuesday 21:00 Riyadh');
});

test('weekly slot stays open for 60 hours and keeps the same key', () => {
  const key = (local: string) => weeklyReportSlot(riyadh(local))?.templateKey ?? null;
  assert.equal(key('2026-10-18T09:00'), 'weekly_report_2026-W42');
  assert.equal(key('2026-10-19T13:00'), 'weekly_report_2026-W42');
  assert.equal(key('2026-10-20T20:59'), 'weekly_report_2026-W42');
  assert.equal(key('2026-10-20T21:00'), null, 'closed at exactly 60 hours');
  assert.equal(key('2026-10-24T12:00'), null);
  assert.equal(key('2026-10-25T09:00'), 'weekly_report_2026-W43');
});

test('weekly key across the new year uses the ISO year of the Sunday', () => {
  assert.equal(weeklyReportSlot(riyadh('2027-01-03T09:00'))?.templateKey, 'weekly_report_2026-W53');
  assert.equal(weeklyReportSlot(riyadh('2027-01-10T09:00'))?.templateKey, 'weekly_report_2027-W01');
  assert.equal(weeklyReportSlot(riyadh('2025-12-28T10:00'))?.templateKey, 'weekly_report_2025-W52');
  assert.equal(weeklyReportSlot(riyadh('2026-01-04T10:00'))?.templateKey, 'weekly_report_2026-W01');
});

test('the weekly slot is a custom weekday and hour when the config says so', () => {
  const slot = weeklyReportSlot(riyadh('2026-10-14T12:00'), { weekday: 3, hour: 10, windowHours: 6 });
  assert.equal(slot?.templateKey, 'weekly_report_2026-W42');
  assert.equal(slot?.dueAt.toISOString(), '2026-10-14T07:00:00.000Z');
  assert.equal(weeklyReportSlot(riyadh('2026-10-14T16:00'), { weekday: 3, hour: 10, windowHours: 6 }), null);
});

test('holdout is sha256 of the user id, first 4 bytes big-endian, modulo 100', () => {
  const expected = (id: string) => createHash('sha256').update(id).digest().readUInt32BE(0) % 100;
  for (const id of ['a', 'user-1', '8f3b1c52-9d4e-4a6b-8c1d-2e7f5a9b0c33', '00000000-0000-0000-0000-000000000000']) {
    assert.equal(isHoldout(id, 100), true);
    assert.equal(isHoldout(id, 0), false);
    for (const percent of [1, 10, 50, 99]) {
      assert.equal(isHoldout(id, percent), expected(id) < percent, `${id} at ${percent}%`);
    }
  }
  assert.equal(isHoldout('user-1'), expected('user-1') < HOLDOUT_PERCENT, 'default percent is the config value');
});

test('holdout is stable and close to the configured share', () => {
  let held = 0;
  const total = 5000;
  for (let i = 0; i < total; i += 1) {
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    assert.equal(isHoldout(id), isHoldout(id));
    if (isHoldout(id)) held += 1;
  }
  const share = held / total;
  assert.ok(share > 0.08 && share < 0.12, `held-out share ${share}`);
});
