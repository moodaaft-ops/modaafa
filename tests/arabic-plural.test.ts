import assert from 'node:assert/strict';
import test from 'node:test';
import { ARABIC_UNITS, arabicCount, formatDays, formatHours } from '../lib/ui/plural';
import { priorWeekLabel, reportPeriodLabel } from '../lib/ui/report-period';

test('hours follow Arabic number grammar from one to the hundreds', () => {
  assert.equal(formatHours(1), 'ساعة واحدة');
  assert.equal(formatHours(2), 'ساعتان');
  assert.equal(formatHours(3), '3 ساعات');
  assert.equal(formatHours(10), '10 ساعات');
  assert.equal(formatHours(11), '11 ساعة');
  assert.equal(formatHours(24), '24 ساعة');
  assert.equal(formatHours(5), '5 ساعات');
});

test('days: the trial length and neighbours read correctly', () => {
  assert.equal(formatDays(14), '14 يوماً');
  assert.equal(formatDays(1), 'يوم واحد');
  assert.equal(formatDays(2), 'يومان');
  assert.equal(formatDays(7), '7 أيام');
  assert.equal(formatDays(100), '100 يوم');
  assert.equal(formatDays(0), '0 يوماً');
});

test('numbers are Latin digits, with grouping for large counts', () => {
  const text = arabicCount(1500, { one: 'a', two: 'b', few: 'c', many: 'رسالة' });
  assert.ok(/1[,٬]500/.test(text), text);
  assert.ok(!/[٠-٩]/.test(text));
});

test('a missing `other` form falls back to the many form', () => {
  assert.equal(arabicCount(100, ARABIC_UNITS.hour), '100 ساعة');
});

test('non-finite counts do not print NaN', () => {
  assert.equal(arabicCount(Number.NaN, ARABIC_UNITS.hour), '0 ساعة');
});

test('report period prints real dates, year once when shared', () => {
  assert.equal(reportPeriodLabel('2026-09-30', '2026-10-07'), 'من 30 سبتمبر إلى 7 أكتوبر 2026');
  assert.equal(reportPeriodLabel('2026-12-28', '2027-01-04'), 'من 28 ديسمبر 2026 إلى 4 يناير 2027');
  assert.equal(reportPeriodLabel('2026-10-07', '2026-10-07'), '7 أكتوبر 2026');
});

test('report period rejects missing or reversed dates instead of guessing', () => {
  assert.equal(reportPeriodLabel(null, '2026-10-07'), null);
  assert.equal(reportPeriodLabel('2026-10-07', '2026-09-30'), null);
  assert.equal(reportPeriodLabel('not a date', '2026-10-07'), null);
});

test('the comparison week is the seven days before the report week', () => {
  assert.equal(priorWeekLabel('2026-09-30'), 'من 23 سبتمبر إلى 29 سبتمبر 2026');
});
