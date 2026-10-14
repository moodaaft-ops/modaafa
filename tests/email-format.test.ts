import assert from 'node:assert/strict';
import test from 'node:test';
import { firstName, formatDateAr, formatMoney, formatNumber } from '../lib/lifecycle/format';

test('formatNumber: Latin digits with a thousands comma', () => {
  assert.equal(formatNumber(0), '0');
  assert.equal(formatNumber(999), '999');
  assert.equal(formatNumber(1250), '1,250');
  assert.equal(formatNumber(1234567), '1,234,567');
  assert.equal(formatNumber(1250.6), '1,251');
  assert.equal(formatNumber(1250.456, { decimals: 2 }), '1,250.46');
  assert.equal(formatNumber(-3400), '-3,400');
  assert.equal(formatNumber(-0.2), '0');
  assert.equal(formatNumber(Number.NaN), '0');
  assert.equal(formatNumber(Number.POSITIVE_INFINITY), '0');
  assert.doesNotMatch(formatNumber(9876543), /[٠-٩۰-۹]/);
});

test('formatMoney: riyal sign after the number for SAR, ISO code after the number for the rest', () => {
  assert.equal(formatMoney(1250, 'SAR'), '1,250 ر.س');
  assert.equal(formatMoney(1250, 'sar'), '1,250 ر.س');
  assert.equal(formatMoney(1250.4, 'SAR'), '1,250 ر.س');
  assert.equal(formatMoney(1250, 'USD'), '1,250 USD');
  assert.equal(formatMoney(980, 'aed'), '980 AED');
  assert.equal(formatMoney(1250, ''), '1,250');
  assert.equal(formatMoney(1250, null), '1,250');
});

test('formatMoney keeps cents on small amounts and drops them on big ones', () => {
  assert.equal(formatMoney(12.5, 'SAR'), '12.5 ر.س');
  assert.equal(formatMoney(12.456, 'SAR'), '12.46 ر.س');
  assert.equal(formatMoney(12, 'SAR'), '12 ر.س');
  assert.equal(formatMoney(4210.75, 'SAR'), '4,211 ر.س');
  assert.equal(formatMoney(12.5, 'SAR', { decimals: 0 }), '13 ر.س');
  assert.equal(formatMoney(12, 'SAR', { decimals: 2 }), '12.00 ر.س');
});

test('formatDateAr: Gregorian Arabic month, Latin digits, read in Riyadh time', () => {
  assert.equal(formatDateAr('2026-10-14T09:00:00Z'), '14 أكتوبر 2026');
  assert.equal(formatDateAr('2026-01-05T12:00:00Z'), '5 يناير 2026');
  assert.equal(formatDateAr('2026-12-31T12:00:00Z'), '31 ديسمبر 2026');
  assert.equal(formatDateAr('2026-10-14T09:00:00Z', { year: false }), '14 أكتوبر');
  // 22:30 UTC on the 14th is 01:30 on the 15th in Riyadh.
  assert.equal(formatDateAr('2026-10-14T22:30:00Z'), '15 أكتوبر 2026');
  // 20:59 UTC is still the 14th (23:59 in Riyadh).
  assert.equal(formatDateAr('2026-10-14T20:59:00Z'), '14 أكتوبر 2026');
  // The year rolls over in Riyadh first.
  assert.equal(formatDateAr('2026-12-31T21:30:00Z'), '1 يناير 2027');
  assert.equal(formatDateAr(new Date('2026-03-01T00:00:00Z')), '1 مارس 2026');
});

test('formatDateAr: all twelve month names', () => {
  const names = [];
  for (let month = 0; month < 12; month += 1) {
    names.push(formatDateAr(new Date(Date.UTC(2026, month, 10, 9)), { year: false }).split(' ')[1]);
  }
  assert.deepEqual(names, [
    'يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
    'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر',
  ]);
});

test('formatDateAr: junk in, empty string out', () => {
  assert.equal(formatDateAr('not a date'), '');
  assert.equal(formatDateAr(''), '');
  assert.equal(formatDateAr(null), '');
  assert.equal(formatDateAr(undefined), '');
});

test('firstName: first word of the name, bounded', () => {
  assert.equal(firstName('  سارة   العتيبي '), 'سارة');
  assert.equal(firstName('أيمن أمين'), 'أيمن');
  assert.equal(firstName(null), '');
  assert.equal(firstName(''), '');
  assert.equal(firstName('x'.repeat(80)), '');
});
