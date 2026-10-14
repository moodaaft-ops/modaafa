import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  STALE_PENDING_DAYS,
  dropStalePending,
  isOptimizerRecommendation,
  isPastStaleLine,
  isStalePendingRecommendation,
  staleCutoffIso,
} from '../lib/recommendations/staleness';
import { toPlanRecommendations } from '../lib/plan/load';

const NOW = Date.parse('2026-10-14T10:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(NOW - days * DAY).toISOString();

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'r1',
  status: 'pending',
  created_at: daysAgo(20),
  action_payload: { operation: 'add_keyword', source: 'optimizer_cron' },
  ...overrides,
});

test('a pending optimizer recommendation is stale after 14 days, not before', () => {
  assert.equal(STALE_PENDING_DAYS, 14);
  assert.equal(isStalePendingRecommendation(row({ created_at: daysAgo(20) }), NOW), true);
  assert.equal(isStalePendingRecommendation(row({ created_at: daysAgo(90) }), NOW), true);
  assert.equal(isStalePendingRecommendation(row({ created_at: daysAgo(14.01) }), NOW), true);
  assert.equal(isStalePendingRecommendation(row({ created_at: daysAgo(14) }), NOW), false);
  assert.equal(isStalePendingRecommendation(row({ created_at: daysAgo(3) }), NOW), false);
});

test('every optimizer source counts, and only pending rows can be stale', () => {
  for (const source of ['optimizer_cron', 'autopilot_observe', 'autopilot_fail_closed', 'autopilot_quota_blocked']) {
    assert.equal(isOptimizerRecommendation({ action_payload: { source } }), true, source);
    assert.equal(isStalePendingRecommendation(row({ action_payload: { source } }), NOW), true, source);
  }
  for (const status of ['approved', 'executing', 'applied', 'dismissed', 'failed']) {
    assert.equal(isStalePendingRecommendation(row({ status }), NOW), false, status);
  }
});

test('a free-audit finding, a Jarvis card and an assistant draft are never stale by age alone', () => {
  assert.equal(isStalePendingRecommendation(row({ action_payload: { operation: 'review_wasted_search_term' } }), NOW), false);
  assert.equal(isStalePendingRecommendation(row({ action_payload: { operation: 'setup_conversion_tracking' } }), NOW), false);
  assert.equal(isStalePendingRecommendation(row({ action_payload: null }), NOW), false);
  assert.equal(isStalePendingRecommendation(row({ action_payload: { operation: 'add_keyword', source: 'jarvis_chat' } }), NOW), false);
  assert.equal(isStalePendingRecommendation(row({ action_payload: { operation: 'manual_campaign_draft', source: 'assistant_chat' } }), NOW), false);
  assert.equal(isStalePendingRecommendation(null, NOW), false);
});

test('an old optimizer row written before the source was recorded is still recognised by its operation', () => {
  for (const operation of ['add_keyword', 'add_negative_keyword', 'adjust_budget', 'adjust_bid', 'pause_keyword', 'pause_ad', 'build_campaign_opportunity']) {
    assert.equal(isOptimizerRecommendation({ action_payload: { operation } }), true, operation);
    assert.equal(isStalePendingRecommendation(row({ action_payload: { operation, params: {} } }), NOW), true, operation);
  }
  assert.equal(isOptimizerRecommendation({ action_payload: { operation: 'review_converting_search_term' } }), false);
  assert.equal(isOptimizerRecommendation({ action_payload: {} }), false);
});

test('a row with no readable age is not stale: nothing proves it', () => {
  assert.equal(isStalePendingRecommendation(row({ created_at: null }), NOW), false);
  assert.equal(isStalePendingRecommendation(row({ created_at: 'not-a-date' }), NOW), false);
  assert.equal(isPastStaleLine(undefined, NOW), false);
  assert.equal(isPastStaleLine(daysAgo(15), NOW), true);
  assert.equal(isPastStaleLine(daysAgo(13), NOW), false);
});

test('dropStalePending keeps current decisions and everything that is not a stale pending optimizer row', () => {
  const rows = [
    row({ id: 'fresh', created_at: daysAgo(2) }),
    row({ id: 'stale', created_at: daysAgo(40) }),
    row({ id: 'approved-old', status: 'approved', created_at: daysAgo(40) }),
    row({ id: 'audit-old', created_at: daysAgo(40), action_payload: { operation: 'review_wasted_search_term' } }),
  ];
  assert.deepEqual(dropStalePending(rows, NOW).map((r) => r.id), ['fresh', 'approved-old', 'audit-old']);
  assert.deepEqual(dropStalePending(null, NOW), []);
  assert.deepEqual(dropStalePending(undefined, NOW), []);
});

test('the stale line is 14 days before now', () => {
  assert.equal(staleCutoffIso(NOW), daysAgo(14));
});

test('the plan (home briefing, plan lock) never lists a stale pending optimizer card as a decision', () => {
  const plan = toPlanRecommendations([
    { id: 'a', title: 'جديدة', status: 'pending', created_at: new Date().toISOString(), action_payload: { source: 'optimizer_cron' } },
    { id: 'b', title: 'قديمة', status: 'pending', created_at: new Date(Date.now() - 30 * DAY).toISOString(), action_payload: { source: 'optimizer_cron' } },
    { id: 'c', title: 'من الفحص', status: 'pending', created_at: new Date(Date.now() - 30 * DAY).toISOString(), action_payload: { operation: 'review_wasted_search_term' } },
  ]);
  assert.deepEqual(plan.map((item) => item.id), ['a', 'c']);
});

test('every list of current decisions drops the stale rows', () => {
  const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  for (const path of [
    'app/(dashboard)/home/page.tsx',
    'app/(dashboard)/optimizer/page.tsx',
    'app/(dashboard)/dashboard/page.tsx',
    'app/api/chat/assistant/route.ts',
    'lib/chat-first/state.ts',
    'lib/plan/load.ts',
  ]) {
    assert.match(read(path), /dropStalePending/, path);
  }
  // The pending locks of the guardrails ignore a stale row too.
  // (holdsTargetLock also lets a stuck approved/executing card go and a non-optimizer pending card age out).
  assert.match(read('lib/ai/optimizer-agent.ts'), /holdsTargetLock\(/);
});
