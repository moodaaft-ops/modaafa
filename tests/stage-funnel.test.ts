import assert from 'node:assert/strict';
import test from 'node:test';
import { computeFunnel, formatPercent, funnelToCsv } from '../lib/stages/funnel';

const NOW = new Date('2026-10-12T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

/**
 * Five accounts counted by hand:
 *   A  registered 20d ago, did nothing else
 *   B  registered 10d ago, connected
 *   C  registered  3d ago, connected, viewed the analysis
 *   D  registered  2d ago, connected, viewed, paid
 *   E  registered  1d ago, connected (its users.stage is still "registered":
 *      the event proves it connected, so the report must trust the event)
 */
const users = [
  { id: 'A', stage: 'registered', createdAt: daysAgo(20) },
  { id: 'B', stage: 'connected', createdAt: daysAgo(10) },
  { id: 'C', stage: 'analysis_viewed', createdAt: daysAgo(3) },
  { id: 'D', stage: 'subscribed', createdAt: daysAgo(2) },
  { id: 'E', stage: 'registered', createdAt: daysAgo(1) },
];
const events = [
  { userId: 'A', eventType: 'registration_completed' },
  { userId: 'B', eventType: 'registration_completed' },
  { userId: 'B', eventType: 'ads_account_connected' },
  { userId: 'C', eventType: 'registration_completed' },
  { userId: 'C', eventType: 'ads_account_connected' },
  { userId: 'C', eventType: 'first_analysis_viewed' },
  { userId: 'D', eventType: 'registration_completed' },
  { userId: 'D', eventType: 'ads_account_connected' },
  { userId: 'D', eventType: 'first_analysis_viewed' },
  { userId: 'D', eventType: 'subscription_paid' },
  { userId: 'E', eventType: 'registration_completed' },
  { userId: 'E', eventType: 'ads_account_connected' },
  { userId: 'E', eventType: 'connect_clicked' },
];

test('all-time numbers match the hand count of five accounts', () => {
  const { allTime } = computeFunnel({ users, events, now: NOW });
  assert.equal(allTime.total, 5);
  assert.deepEqual(allTime.rows.map((r) => r.reached), [5, 4, 2, 1]);
  assert.deepEqual(allTime.rows.map((r) => r.current), [1, 2, 1, 1]);
  assert.deepEqual(allTime.rows.map((r) => r.rateToNext), [4 / 5, 2 / 4, 1 / 2, null]);
});

test('last 7 days counts only people who registered in the window', () => {
  const { recent } = computeFunnel({ users, events, now: NOW });
  assert.equal(recent.total, 3); // C, D, E
  assert.deepEqual(recent.rows.map((r) => r.reached), [3, 3, 2, 1]);
  assert.deepEqual(recent.rows.map((r) => r.current), [0, 1, 1, 1]);
  assert.equal(formatPercent(recent.rows[0].rateToNext), '100%');
  assert.equal(formatPercent(recent.rows[1].rateToNext), '66.7%');
  assert.equal(formatPercent(recent.rows[2].rateToNext), '50%');
});

test('an empty stage has no conversion rate instead of a divide-by-zero', () => {
  const report = computeFunnel({ users: [{ id: 'X', stage: 'registered', createdAt: daysAgo(30) }], events: [], now: NOW });
  assert.deepEqual(report.recent.rows.map((r) => r.reached), [0, 0, 0, 0]);
  assert.equal(report.recent.rows[0].rateToNext, null);
});

test('the CSV has a byte-order mark, one row per stage and the same numbers as the page', () => {
  const csv = funnelToCsv(computeFunnel({ users, events, now: NOW }));
  assert.ok(csv.startsWith('﻿'));
  const lines = csv.trim().split('\r\n');
  assert.equal(lines.length, 5);
  assert.equal(lines[1], 'سجّل,5,1,80%,3,0,100%');
  assert.equal(lines[4], 'دفع الاشتراك,1,1,,1,1,');
});
