import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  evaluateOperationalJob,
  evaluateWebhookLedger,
  extractEmailDomain,
} from '../lib/platform/health';

test('operational email health follows the configured sender domain', () => {
  assert.equal(extractEmailDomain('مضاعفة <alerts@notify.modaafa.com>'), 'notify.modaafa.com');
  assert.equal(extractEmailDomain('support@modaafa.com'), 'modaafa.com');
  assert.equal(extractEmailDomain('invalid sender'), null);
});

test('a fresh low-error partial job can pass but a high-error partial job cannot', () => {
  const now = Date.parse('2026-08-12T12:00:00Z');
  const base = {
    job_name: 'sync-google-ads',
    status: 'partial',
    started_at: '2026-08-12T11:00:00Z',
  };

  assert.equal(
    evaluateOperationalJob(
      { ...base, processed: 9, error_count: 1 },
      { jobName: 'sync-google-ads', maxAgeHours: 4, now }
    ).ok,
    true
  );
  assert.equal(
    evaluateOperationalJob(
      { ...base, processed: 1, error_count: 9 },
      { jobName: 'sync-google-ads', maxAgeHours: 4, now }
    ).ok,
    false
  );
});

test('failed, stale, or missing operational jobs fail health', () => {
  const now = Date.parse('2026-08-12T12:00:00Z');
  const options = { jobName: 'optimize', maxAgeHours: 4, now };

  assert.equal(evaluateOperationalJob(null, options).ok, false);
  assert.equal(
    evaluateOperationalJob(
      { status: 'failed', started_at: '2026-08-12T11:30:00Z' },
      options
    ).ok,
    false
  );
  assert.equal(
    evaluateOperationalJob(
      { status: 'success', started_at: '2026-08-12T01:00:00Z' },
      options
    ).ok,
    false
  );
});

test('the webhook ledger flags failed and abandoned processing rows', () => {
  const now = Date.parse('2026-08-12T12:00:00Z');
  assert.equal(
    evaluateWebhookLedger(
      [{ status: 'completed', last_attempt_at: '2026-08-12T11:59:00Z' }],
      now
    ).ok,
    true
  );
  assert.equal(
    evaluateWebhookLedger(
      [{ status: 'failed', last_attempt_at: '2026-08-12T11:59:00Z' }],
      now
    ).ok,
    false
  );
  assert.equal(
    evaluateWebhookLedger(
      [{ status: 'processing', last_attempt_at: '2026-08-12T11:00:00Z' }],
      now
    ).ok,
    false
  );
});

test('the public health endpoint checks the database and fails closed', () => {
  const healthRoute = readFileSync(resolve('app/api/health/route.ts'), 'utf8');
  assert.match(healthRoute, /const heartbeat = await checkPublicDatabaseHeartbeat\(\)/);
  assert.match(healthRoute, /status: heartbeat \? 200 : 503/);
  assert.match(healthRoute, /from\('businesses'\)\.select\('id'\)\.limit\(1\)/);
});
