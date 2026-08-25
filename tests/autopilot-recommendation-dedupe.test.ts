import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUTOPILOT_FAILED_RETRY_COOLDOWN_MS,
  blocksAutopilotFingerprint,
} from '../lib/autopilot/recommendation-dedupe';

const NOW = Date.parse('2026-08-25T12:00:00.000Z');

test('active, applied and user-dismissed recommendations permanently block duplicates', () => {
  for (const status of ['pending', 'approved', 'executing', 'applied', 'dismissed']) {
    assert.equal(
      blocksAutopilotFingerprint(
        { id: status, status, created_at: '2025-01-01T00:00:00.000Z' },
        NOW
      ),
      true,
      status
    );
  }
});

test('a recent technical failure blocks an immediate autopilot retry', () => {
  assert.equal(
    blocksAutopilotFingerprint(
      {
        id: 'failed-recently',
        status: 'failed',
        created_at: new Date(NOW - AUTOPILOT_FAILED_RETRY_COOLDOWN_MS + 1_000).toISOString(),
      },
      NOW
    ),
    true
  );
});

test('a technical failure becomes retryable after the quiet period', () => {
  assert.equal(
    blocksAutopilotFingerprint(
      {
        id: 'failed-yesterday',
        status: 'failed',
        created_at: new Date(NOW - AUTOPILOT_FAILED_RETRY_COOLDOWN_MS).toISOString(),
      },
      NOW
    ),
    false
  );
});

test('malformed failure timestamps fail closed', () => {
  assert.equal(
    blocksAutopilotFingerprint(
      { id: 'failed-unknown', status: 'failed', created_at: 'not-a-date' },
      NOW
    ),
    true
  );
});

test('missing and unrelated terminal rows do not block a fingerprint', () => {
  assert.equal(blocksAutopilotFingerprint(null, NOW), false);
  assert.equal(
    blocksAutopilotFingerprint(
      { id: 'ignored', status: 'superseded', created_at: '2026-08-25T00:00:00.000Z' },
      NOW
    ),
    false
  );
});
