import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDailyPlan } from '../lib/guidance/daily-plan';

const NOW = new Date('2026-08-24T12:00:00.000Z');

function plan(overrides: Partial<Parameters<typeof buildDailyPlan>[0]> = {}) {
  return buildDailyPlan({
    hasAccount: true,
    subscriptionActive: true,
    campaignCount: 3,
    lastSyncedAt: '2026-08-24T10:00:00.000Z',
    latestAuditAt: '2026-08-24T09:00:00.000Z',
    recommendations: [],
    actions: [],
    now: NOW,
    ...overrides,
  });
}

test('starts a new workspace with one clear Google Ads connection action', () => {
  const result = plan({ hasAccount: false, campaignCount: 0, latestAuditAt: null, lastSyncedAt: null });
  assert.equal(result.primary.id, 'connect');
  assert.equal(result.primary.href, '/onboarding/connect');
});

test('puts stale data before a new audit decision', () => {
  const result = plan({
    lastSyncedAt: '2026-08-20T08:00:00.000Z',
    latestAuditAt: '2026-08-10T08:00:00.000Z',
  });
  assert.equal(result.primary.id, 'sync');
  assert.ok(result.tasks.some((task) => task.id === 'audit'));
});

test('surfaces the most severe pending recommendation as the next decision', () => {
  const result = plan({
    recommendations: [
      { id: 'growth', status: 'pending', severity: 'growth', title: 'وسّع الوصول' },
      { id: 'critical', status: 'pending', severity: 'critical', title: 'أوقف الهدر' },
    ],
  });
  assert.equal(result.primary.id, 'pending-recommendations');
  assert.match(result.primary.description, /أوقف الهدر/);
  assert.equal(result.pendingDecisions, 2);
});

test('asks for outcome measurement after an applied action has had time to settle', () => {
  const result = plan({
    actions: [
      {
        id: 'action-1',
        description_ar: 'إضافة كلمة سلبية',
        created_at: '2026-08-22T09:00:00.000Z',
        observed_impact: null,
      },
    ],
  });
  assert.equal(result.primary.id, 'measure-action');
  assert.match(result.primary.description, /إضافة كلمة سلبية/);
});

test('recommends monitoring when the account needs no immediate action', () => {
  const result = plan();
  assert.equal(result.primary.id, 'monitor');
  assert.equal(result.tasks.length, 1);
});
