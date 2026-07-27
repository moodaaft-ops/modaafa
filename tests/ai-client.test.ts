import assert from 'node:assert/strict';
import test from 'node:test';
import { rankModelCandidates } from '../lib/ai/client';

const models = [
  { id: 'claude-haiku-4-5-20251001', createdAt: '2025-10-01T00:00:00Z' },
  { id: 'claude-sonnet-4-20250514', createdAt: '2025-05-14T00:00:00Z' },
  { id: 'claude-sonnet-4-6-20260217', createdAt: '2026-02-17T00:00:00Z' },
  { id: 'claude-opus-4-1-20250805', createdAt: '2025-08-05T00:00:00Z' },
  { id: 'unrelated-model', createdAt: '2030-01-01T00:00:00Z' },
];

test('reporting prefers the newest available Sonnet model', () => {
  assert.deepEqual(rankModelCandidates(models, 'sonnet').slice(0, 2), [
    'claude-sonnet-4-6-20260217',
    'claude-sonnet-4-20250514',
  ]);
});

test('high-stakes agents prefer Opus before Sonnet and Haiku', () => {
  const ranked = rankModelCandidates(models, 'opus');
  assert.equal(ranked[0], 'claude-opus-4-1-20250805');
  assert.ok(ranked.indexOf('claude-sonnet-4-6-20260217') < ranked.indexOf('claude-haiku-4-5-20251001'));
});

test('model ranking ignores non-Claude entries', () => {
  assert.ok(!rankModelCandidates(models, 'sonnet').includes('unrelated-model'));
});
