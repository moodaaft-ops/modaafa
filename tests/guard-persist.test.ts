import assert from 'node:assert/strict';
import test from 'node:test';
import { CRITICAL_REMIND_MS, NOTIFY_FRESH_MS, isNotifiable, reconcile, type StoredFinding } from '../lib/guard/persist';
import type { GuardFinding } from '../lib/guard/types';
import { ALL_OK } from './support/guard';

const finding = (dedupeKey: string, code: GuardFinding['code'] = 'spend_zero', severity: GuardFinding['severity'] = 'high'): GuardFinding => ({
  code,
  severity,
  entityType: 'account',
  entityId: '1',
  entityName: null,
  whatAr: 'x',
  stepAr: 'y',
  evidence: {},
  dedupeKey,
  escalation: 'none',
  cause: null,
});
const stored = (dedupe_key: string, code: StoredFinding['code'] = 'spend_zero', status: StoredFinding['status'] = 'open', seen_count = 1) => ({
  id: `id-${dedupe_key}`,
  code,
  dedupe_key,
  status,
  seen_count,
});

test('reconcile: a new key is inserted, a known open key is only touched (never re-sent)', () => {
  const plan = reconcile([stored('spend_zero:account', 'spend_zero', 'open', 3)], [finding('spend_zero:account'), finding('spend_spike:account', 'spend_spike')], ALL_OK);
  assert.deepEqual(plan.upsert.map((f) => f.dedupeKey), ['spend_spike:account']);
  assert.equal(plan.touch.length, 1);
  assert.equal(plan.touch[0].seenCount, 4);
  assert.deepEqual(plan.resolve, []);
});

test('reconcile: an open finding that is gone is resolved when its source was readable', () => {
  const plan = reconcile([stored('spend_zero:account')], [], ALL_OK);
  assert.deepEqual(plan.resolve, ['id-spend_zero:account']);
});

test('reconcile: an unreadable source never closes its findings (unknown is not all clear)', () => {
  const plan = reconcile(
    [stored('spend_zero:account'), stored('ad_policy:1:DISAPPROVED:abc', 'ad_policy'), stored('account_status:SUSPENDED', 'account_status')],
    [],
    { ...ALL_OK, daily: false }
  );
  assert.deepEqual(plan.resolve.sort(), ['id-account_status:SUSPENDED', 'id-ad_policy:1:DISAPPROVED:abc']);
});

test('reconcile: a dismissed finding that is still true stays quiet; a resolved one that comes back is reinserted', () => {
  // Resolved rows are not loaded, so a returning key looks new and is written whole (notified_at cleared).
  const back = reconcile([], [finding('spend_zero:account')], ALL_OK);
  assert.equal(back.upsert.length, 1);
  const dismissed = reconcile([stored('spend_zero:account', 'spend_zero', 'dismissed')], [finding('spend_zero:account')], ALL_OK);
  assert.equal(dismissed.upsert.length, 0);
  assert.equal(dismissed.resolve.length, 0);
});

test('reconcile: the same key twice in one run counts once', () => {
  const plan = reconcile([], [finding('a'), finding('a')], ALL_OK);
  assert.equal(plan.upsert.length, 1);
});

const row = (over: Partial<StoredFinding>): StoredFinding => ({
  id: '1',
  account_id: 'a',
  code: 'spend_zero',
  dedupe_key: 'k',
  severity: 'high',
  status: 'open',
  first_seen_at: '2026-10-19T02:30:00Z',
  last_seen_at: '2026-10-19T02:30:00Z',
  seen_count: 1,
  notified_at: null,
  what_ar: 'x',
  step_ar: 'y',
  evidence: {},
  cause: null,
  escalation: 'none',
  entity_name: null,
  ...over,
});
const NOW = new Date('2026-10-19T03:00:00Z');

test('notifiable: new and unsent yes; already sent no; info never; stale first sighting no', () => {
  assert.equal(isNotifiable(row({}), NOW), true);
  assert.equal(isNotifiable(row({ notified_at: '2026-10-19T02:40:00Z' }), NOW), false);
  assert.equal(isNotifiable(row({ severity: 'info' }), NOW), false);
  assert.equal(isNotifiable(row({ status: 'resolved' }), NOW), false);
  assert.equal(isNotifiable(row({ status: 'dismissed' }), NOW), false);
  assert.equal(isNotifiable(row({ first_seen_at: new Date(NOW.getTime() - NOTIFY_FRESH_MS - 1000).toISOString() }), NOW), false);
});

test('notifiable: only a critical one is said again, and only after a week', () => {
  const sent = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
  assert.equal(isNotifiable(row({ severity: 'critical', notified_at: sent(CRITICAL_REMIND_MS + 1000) }), NOW), true);
  assert.equal(isNotifiable(row({ severity: 'critical', notified_at: sent(CRITICAL_REMIND_MS - 60_000) }), NOW), false);
  assert.equal(isNotifiable(row({ severity: 'high', notified_at: sent(CRITICAL_REMIND_MS * 3) }), NOW), false);
});
