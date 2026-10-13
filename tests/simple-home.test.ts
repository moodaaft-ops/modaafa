import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decisionsLabel,
  greetingFor,
  noticeFrom,
  orderDecisions,
  summaryLine,
  weekNumbers,
} from '../lib/home/briefing';
import { homeTargetFrom, simpleOnboardingTarget } from '../lib/setup/routes';

const money = (n: number) => `${Math.round(n)} ر.س`;

test('the week adds up the synced 7-day numbers and counts live campaigns', () => {
  const week = weekNumbers([
    { status: 'ENABLED', metrics_7d: { cost: 600, conversions: 9 } },
    { status: 'ENABLED', metrics_7d: { cost_micros: 400_000_000, conversions: 6 } },
    { status: 'PAUSED', metrics_7d: { cost: 0, conversions: 0 } },
  ]);
  assert.equal(week.activeCampaigns, 2);
  assert.equal(week.results, 15);
  assert.ok(week.spend >= 600);
  assert.equal(week.hasData, true);
  assert.equal(weekNumbers([]).hasData, false);
  assert.equal(weekNumbers([]).costPerResult, null);
});

test('the summary says what happened and what to do, without inventing numbers', () => {
  const week = { spend: 1240, results: 18, costPerResult: 69, activeCampaigns: 3, hasData: true };
  assert.equal(
    summaryLine({ week, decisions: 4, money }),
    'آخر 7 أيام صرفت 1240 ر.س وجاك منها 18 نتيجة. عندي لك 4 قرارات اليوم، ابدأ بأولها.'
  );
  assert.match(summaryLine({ week: { ...week, results: 0, costPerResult: null }, decisions: 0, money }), /ما انسجلت ولا نتيجة/);
  assert.match(summaryLine({ week: { ...week, hasData: false }, decisions: 0, money }), /ما شفت صرف/);
  // Live campaigns with zero spend must not read "you spent 0 SAR".
  const idle = summaryLine({ week: { ...week, spend: 0, results: 0, costPerResult: null }, decisions: 0, money });
  assert.match(idle, /ما شفت صرف/);
  assert.doesNotMatch(idle, /صرفت 0/);
  assert.equal(decisionsLabel(1), 'قرار واحد');
  assert.equal(decisionsLabel(2), 'قرارين');
  assert.equal(decisionsLabel(11), '11 قرار');
});

test('copy never uses the long dash', () => {
  const week = { spend: 10, results: 1, costPerResult: 10, activeCampaigns: 1, hasData: true };
  for (const decisions of [0, 1, 5]) {
    assert.doesNotMatch(summaryLine({ week, decisions, money }), /[–—]/);
  }
});

test('approved decisions first, then by severity, then newest', () => {
  const ordered = orderDecisions([
    { id: 'a', severity: 'growth', status: 'pending', created_at: '2026-10-12' },
    { id: 'b', severity: 'critical', status: 'pending', created_at: '2026-10-10' },
    { id: 'c', severity: 'growth', status: 'approved', created_at: '2026-10-01' },
    { id: 'd', severity: 'critical', status: 'pending', created_at: '2026-10-11' },
  ]);
  assert.deepEqual(ordered.map((row) => row.id), ['c', 'd', 'b', 'a']);
});

test('Riyadh greeting by the hour', () => {
  assert.equal(greetingFor(new Date('2026-10-13T05:00:00Z')), 'صباح الخير');
  assert.equal(greetingFor(new Date('2026-10-13T15:00:00Z')), 'مساء الخير');
});

test('notices map the redirect params the forms add', () => {
  assert.equal(noticeFrom({ executed: '1' })?.tone, 'ok');
  assert.equal(noticeFrom({ error: 'execution_failed' })?.tone, 'bad');
  assert.equal(noticeFrom({ error: 'something_new' })?.tone, 'bad');
  assert.equal(noticeFrom({}), null);
});

test('old onboarding paths forward into the setup chat', () => {
  assert.equal(simpleOnboardingTarget('connect'), '/onboarding');
  assert.equal(simpleOnboardingTarget('connect', { error: 'no_accounts' }), '/onboarding?error=no_accounts');
  assert.equal(simpleOnboardingTarget('connect', {}, { hasAccounts: true }), '/onboarding?connect=1');
  assert.equal(
    simpleOnboardingTarget('connect', { error: 'access_denied' }, { hasAccounts: true }),
    '/onboarding?connect=1&error=access_denied'
  );
  // Anything that is not a plain code is dropped, never echoed into the URL.
  assert.equal(simpleOnboardingTarget('connect', { error: 'x"><script>' }), '/onboarding');
  assert.equal(simpleOnboardingTarget('business', {}, { hasAccounts: true }), '/onboarding?edit=1');
  assert.equal(simpleOnboardingTarget('business'), '/onboarding');
  assert.equal(simpleOnboardingTarget('first-audit', { subscribed: '1' }), '/home?subscribed=1');
  assert.equal(simpleOnboardingTarget('preparing'), '/onboarding');
});

test('the old home screens forward to /home with only the result params', () => {
  assert.equal(homeTargetFrom({}), '/home');
  assert.equal(homeTargetFrom({ executed: '1', range: '30d' }), '/home?executed=1');
  assert.equal(homeTargetFrom({ error: 'execution_failed' }), '/home?error=execution_failed');
  assert.equal(homeTargetFrom({ error: '../../x' }), '/home');
});
