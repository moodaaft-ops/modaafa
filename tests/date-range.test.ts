import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_CUSTOM_RANGE_DAYS,
  dateRangeHref,
  resolveDateRange,
  validateCustomDateRange,
} from '../lib/analytics/date-range';

const NOW = new Date('2026-08-22T12:00:00.000Z');

test('date range presets resolve to cached and live windows', () => {
  const seven = resolveDateRange({ range: '7d' }, '30d', NOW);
  assert.deepEqual(
    { key: seven.key, from: seven.from, to: seven.to, days: seven.days, metricKey: seven.metricKey },
    { key: '7d', from: '2026-08-16', to: '2026-08-22', days: 7, metricKey: 'metrics_7d' }
  );

  const ninety = resolveDateRange({ range: '90d' }, '7d', NOW);
  assert.equal(ninety.key, '90d');
  assert.equal(ninety.days, 90);
  assert.equal(ninety.metricKey, null);
});

test('a valid custom date range is inclusive and keeps its dates in the URL', () => {
  const selection = resolveDateRange(
    { range: 'custom', from: '2026-08-01', to: '2026-08-22' },
    '7d',
    NOW
  );

  assert.equal(selection.key, 'custom');
  assert.equal(selection.days, 22);
  assert.equal(selection.metricKey, null);
  assert.equal(selection.error, null);
  assert.equal(
    dateRangeHref('/campaigns', selection),
    '/campaigns?range=custom&from=2026-08-01&to=2026-08-22'
  );
});

test('invalid custom ranges fall back safely with an Arabic explanation', () => {
  const missing = resolveDateRange({ range: 'custom' }, '30d', NOW);
  assert.equal(missing.key, '30d');
  assert.match(missing.error ?? '', /البداية والنهاية/);

  const reversed = validateCustomDateRange('2026-08-22', '2026-08-01', '2026-08-22');
  assert.equal(reversed.ok, false);

  const future = validateCustomDateRange('2026-08-01', '2026-08-23', '2026-08-22');
  assert.equal(future.ok, false);

  const invalid = validateCustomDateRange('2026-02-30', '2026-03-01', '2026-08-22');
  assert.equal(invalid.ok, false);
});

test('custom reports are capped to one inclusive year', () => {
  const tooLong = validateCustomDateRange('2025-08-21', '2026-08-22', '2026-08-22');
  assert.equal(tooLong.ok, false);
  if (!tooLong.ok) assert.match(tooLong.error, new RegExp(String(MAX_CUSTOM_RANGE_DAYS)));

  const allowed = validateCustomDateRange('2025-08-22', '2026-08-22', '2026-08-22');
  assert.equal(allowed.ok, true);
  if (allowed.ok) assert.equal(allowed.days, MAX_CUSTOM_RANGE_DAYS);
});
