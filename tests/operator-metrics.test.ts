import assert from 'node:assert/strict';
import test from 'node:test';
import {
  operatorJobStatusLabel,
  operatorJobStatusTone,
  summarizeUsageEvents,
} from '../lib/platform/operator-metrics';

test('usage summary keeps every product feature visible and in a stable order', () => {
  const summary = summarizeUsageEvents([
    { feature: 'assistant' },
    { feature: 'assistant' },
    { feature: 'audit' },
    { feature: 'unknown' },
  ]);

  assert.deepEqual(
    summary.map((item) => [item.feature, item.count]),
    [
      ['assistant', 2],
      ['audit', 1],
      ['manual_sync', 0],
      ['campaign_builder', 0],
      ['execute_action', 0],
    ]
  );
});

test('job states use customer-readable Arabic labels and tones', () => {
  assert.equal(operatorJobStatusLabel('partial'), 'نجح جزئياً');
  assert.equal(operatorJobStatusTone('failed'), 'danger');
  assert.equal(operatorJobStatusTone('success'), 'success');
});
