import test from 'node:test';
import assert from 'node:assert/strict';
import { accountsAr, daysAr, daysUntil, trialLabelAr } from '../lib/ui/plural-ar';

test('Arabic day counts agree with the number', () => {
  assert.equal(daysAr(1), 'يوم واحد');
  assert.equal(daysAr(2), 'يومان');
  assert.equal(daysAr(3), '3 أيام');
  assert.equal(daysAr(10), '10 أيام');
  assert.equal(daysAr(11), '11 يوماً');
  assert.equal(daysAr(14), '14 يوماً');
});

test('Arabic account counts agree with the number', () => {
  assert.equal(accountsAr(1), 'حساب واحد');
  assert.equal(accountsAr(2), 'حسابان');
  assert.equal(accountsAr(7), '7 حسابات');
  assert.equal(accountsAr(39), '39 حساباً');
});

test('trial days left round up and expire cleanly', () => {
  const now = Date.parse('2026-10-07T12:00:00Z');
  assert.equal(daysUntil('2026-10-08T00:00:00Z', now), 1);
  assert.equal(daysUntil('2026-10-21T12:00:00Z', now), 14);
  assert.equal(daysUntil('2026-10-07T11:00:00Z', now), null);
  assert.equal(daysUntil(null, now), null);
  assert.equal(trialLabelAr(5), 'باقي 5 أيام على نهاية التجربة');
});
