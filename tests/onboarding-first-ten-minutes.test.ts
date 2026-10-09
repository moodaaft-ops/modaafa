import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isSafeWebsite,
  normalizeWebsiteInput,
  parseMonthlyBudget,
  parseTargetRegions,
  validateBusinessForm,
} from '../lib/onboarding/business-form';
import {
  CONNECT_TIMEOUT_MS,
  connectErrorRecoveryHref,
  connectJobName,
  connectPollDelayMs,
  nextStepAfterConnect,
  resolveConnectProgress,
  safeOnboardingNext,
} from '../lib/onboarding/connect-progress';
import { accountStatusView, accountsCountLabel, sortAccountsBySpend } from '../lib/onboarding/account-choice';
import { daysLabel, firstChargeDate } from '../lib/onboarding/trial';
import {
  impactLabel,
  isFirstAuditGuardActive,
  pickFirstOpportunities,
  recommendationsCountLabel,
} from '../lib/onboarding/first-opportunities';

const validForm = {
  name: 'عيادة الأمواج',
  sector: 'صحة',
  website: '',
  monthly_budget: '15000',
  primary_goal: 'leads',
  target_regions: 'الرياض، جدة',
};

test('website input gets https:// prepended only when no scheme is present', () => {
  assert.equal(normalizeWebsiteInput('example.com'), 'https://example.com');
  assert.equal(normalizeWebsiteInput('  www.example.com/path '), 'https://www.example.com/path');
  assert.equal(normalizeWebsiteInput('//example.com'), 'https://example.com');
  assert.equal(normalizeWebsiteInput('http://example.com'), 'http://example.com');
  assert.equal(normalizeWebsiteInput('HTTPS://Example.com'), 'HTTPS://Example.com');
  assert.equal(normalizeWebsiteInput(''), '');
  assert.equal(normalizeWebsiteInput(undefined), '');
});

test('only http(s) sites with a dotted hostname are accepted', () => {
  assert.equal(isSafeWebsite('https://example.com'), true);
  assert.equal(isSafeWebsite('https://متجر.السعودية'), true);
  assert.equal(isSafeWebsite('https://example'), false);
  assert.equal(isSafeWebsite('javascript:alert(1)'), false);
  assert.equal(isSafeWebsite('ftp://example.com'), false);
  assert.equal(isSafeWebsite('https://exa mple.com'), false);
});

test('budget accepts whole numbers, Arabic digits and separators, nothing else', () => {
  assert.equal(parseMonthlyBudget(''), 0);
  assert.equal(parseMonthlyBudget('15000'), 15000);
  assert.equal(parseMonthlyBudget('١٥٠٠٠'), 15000);
  assert.equal(parseMonthlyBudget('15,000'), 15000);
  assert.equal(parseMonthlyBudget('1500.5'), null);
  assert.equal(parseMonthlyBudget('-5'), null);
  assert.equal(parseMonthlyBudget('abc'), null);
  assert.equal(parseMonthlyBudget('2000000000'), null);
});

test('regions split on Latin comma, Arabic comma and newlines', () => {
  assert.deepEqual(parseTargetRegions('الرياض، جدة,الدمام\nمكة , '), ['الرياض', 'جدة', 'الدمام', 'مكة']);
});

test('form validation reports each bad field and passes a good form', () => {
  assert.deepEqual(validateBusinessForm(validForm), {});
  assert.deepEqual(validateBusinessForm({ ...validForm, website: 'example.com' }), {});
  const errors = validateBusinessForm({
    ...validForm,
    name: '  ',
    website: 'not a site',
    monthly_budget: '10.5',
    primary_goal: 'growth',
  });
  assert.deepEqual(Object.keys(errors).sort(), ['monthly_budget', 'name', 'primary_goal', 'website']);
  assert.equal(validateBusinessForm({ ...validForm, name: 'x'.repeat(121) }).name !== undefined, true);
});

test('connect job name is per user so the one-running-row index never blocks another user', () => {
  assert.equal(connectJobName('u-1'), 'google_ads_connect:u-1');
  assert.notEqual(connectJobName('u-1'), connectJobName('u-2'));
});

test('stage mapping: no job, each running stage, done and failed', () => {
  const now = Date.parse('2026-10-07T10:00:00Z');
  const startedAt = new Date(now - 10_000).toISOString();

  const none = resolveConnectProgress(null, now);
  assert.equal(none.phase, 'none');
  assert.deepEqual(none.stages.map((s) => s.state), ['pending', 'pending', 'pending']);

  const discovering = resolveConnectProgress({ status: 'running', started_at: startedAt, details: { stage: 'discover' } }, now);
  assert.equal(discovering.phase, 'running');
  assert.deepEqual(discovering.stages.map((s) => s.state), ['active', 'pending', 'pending']);

  const reading = resolveConnectProgress({ status: 'running', started_at: startedAt, details: { stage: 'read' } }, now);
  assert.deepEqual(reading.stages.map((s) => s.state), ['done', 'active', 'pending']);

  const syncing = resolveConnectProgress({ status: 'running', started_at: startedAt, details: { stage: 'sync' } }, now);
  assert.deepEqual(syncing.stages.map((s) => s.state), ['done', 'done', 'active']);

  const done = resolveConnectProgress(
    { status: 'success', started_at: startedAt, details: { stage: 'done', next: '/onboarding/choose' } },
    now
  );
  assert.equal(done.phase, 'done');
  assert.equal(done.next, '/onboarding/choose');
  assert.deepEqual(done.stages.map((s) => s.state), ['done', 'done', 'done']);

  const failed = resolveConnectProgress(
    { status: 'failed', started_at: startedAt, details: { stage: 'read', error: 'db_error' } },
    now
  );
  assert.equal(failed.phase, 'failed');
  assert.equal(failed.error, 'db_error');
  assert.deepEqual(failed.stages.map((s) => s.state), ['done', 'failed', 'pending']);
});

test('a running job older than the function limit is reported as a timeout', () => {
  const now = Date.parse('2026-10-07T10:00:00Z');
  const view = resolveConnectProgress(
    { status: 'running', started_at: new Date(now - CONNECT_TIMEOUT_MS - 1).toISOString(), details: { stage: 'sync' } },
    now
  );
  assert.equal(view.phase, 'timed_out');
  assert.equal(view.error, 'timeout');
  assert.deepEqual(view.stages.map((s) => s.state), ['done', 'done', 'failed']);
  assert.ok(CONNECT_TIMEOUT_MS > 300_000, 'timeout must outlast maxDuration');
});

test('only allowlisted next paths are followed', () => {
  assert.equal(safeOnboardingNext('/onboarding/trial'), '/onboarding/trial');
  assert.equal(safeOnboardingNext('/dashboard?connected=1'), '/dashboard?connected=1');
  assert.equal(safeOnboardingNext('https://evil.example'), null);
  assert.equal(safeOnboardingNext('//evil.example/onboarding/trial'), null);
  assert.equal(safeOnboardingNext('/settings'), null);
  assert.equal(safeOnboardingNext(undefined), null);
});

test('next step: returning users go back, several accounts choose, one account skips the chooser', () => {
  assert.equal(nextStepAfterConnect({ linkableCount: 5, persistedSelectionStillLinked: true }), '/dashboard?connected=1');
  assert.equal(nextStepAfterConnect({ linkableCount: 5, persistedSelectionStillLinked: false }), '/onboarding/choose');
  assert.equal(nextStepAfterConnect({ linkableCount: 1, persistedSelectionStillLinked: false }), '/onboarding/first-audit');
});

test('errors with a recovery block hand over to the connect page', () => {
  assert.equal(connectErrorRecoveryHref('no_accounts'), '/onboarding/connect?error=no_accounts');
  assert.equal(connectErrorRecoveryHref('no_client_accounts'), '/onboarding/connect?error=no_client_accounts');
  assert.equal(connectErrorRecoveryHref('timeout'), null);
});

test('poll delay backs off as the wait grows', () => {
  assert.ok(connectPollDelayMs(0) < connectPollDelayMs(60_000));
  assert.ok(connectPollDelayMs(60_000) < connectPollDelayMs(200_000));
});

test('chooser orders by known spend, unknown spend last, then by status', () => {
  const ranked = sortAccountsBySpend(
    [
      { customer_id: '1111111111', customer_name: 'A', google_status: 'ENABLED' },
      { customer_id: '2222222222', customer_name: 'B', google_status: 'ENABLED' },
      { customer_id: '3333333333', customer_name: 'C', google_status: 'SUSPENDED' },
      { customer_id: '4444444444', customer_name: 'D', google_status: 'ENABLED' },
      { customer_id: '5555555555', customer_name: 'E', google_status: 'CLOSED' },
    ],
    { '1111111111': 120, '2222222222': 9000, '3333333333': 0, '4444444444': null }
  );
  assert.deepEqual(
    ranked.map((account) => account.customer_id),
    ['2222222222', '1111111111', '3333333333', '4444444444', '5555555555']
  );
  assert.equal(ranked[3].spend, null);
});

test('status square tone: running, needs attention, stopped', () => {
  assert.equal(accountStatusView('ENABLED').tone, 'active');
  assert.equal(accountStatusView('SUSPENDED').tone, 'attention');
  assert.equal(accountStatusView('CLOSED').tone, 'stopped');
  assert.equal(accountStatusView(null).tone, 'stopped');
});

test('Arabic plurals for accounts, days and recommendations', () => {
  assert.equal(accountsCountLabel(1), 'حساب واحد');
  assert.equal(accountsCountLabel(2), 'حسابان');
  assert.equal(accountsCountLabel(5), '5 حسابات');
  assert.equal(accountsCountLabel(39), '39 حساباً');
  assert.equal(accountsCountLabel(100), '100 حساب');
  assert.equal(daysLabel(14), '14 يوماً');
  assert.equal(daysLabel(7), '7 أيام');
  assert.equal(daysLabel(1), 'يوم واحد');
  assert.equal(recommendationsCountLabel(3), '3 توصيات');
  assert.equal(recommendationsCountLabel(2), 'توصيتان');
});

test('first charge lands trial days after today', () => {
  const now = new Date('2026-10-07T12:00:00Z');
  assert.equal(firstChargeDate(14, now).toISOString().slice(0, 10), '2026-10-21');
});

test('first opportunities: severity first, then impact; impact named saving or increase', () => {
  const rows = [
    { id: 'g', title: 'g', severity: 'growth', expected_impact: { metric: 'conversions', delta_sar_per_month: 5000 } },
    { id: 'm', title: 'm', severity: 'medium', expected_impact: { metric: 'cost', delta_sar_per_month: 100 } },
    { id: 'c1', title: 'c1', severity: 'critical', expected_impact: { metric: 'cost', delta_sar_per_month: 10 } },
    { id: 'c2', title: 'c2', severity: 'critical', expected_impact: { metric: 'cost', delta_sar_per_month: 900 } },
  ];
  assert.deepEqual(pickFirstOpportunities(rows).map((row) => row.id), ['c2', 'c1', 'm']);
  assert.equal(impactLabel(rows[1]), 'توفير متوقع شهرياً');
  assert.equal(impactLabel(rows[0]), 'زيادة متوقعة شهرياً');
  assert.equal(impactLabel({ id: 'x', title: 'x', expected_impact: { delta_sar_per_month: 0 } }), null);
});

test('first audit guard blocks a second start only while fresh', () => {
  const now = 1_000_000_000;
  assert.equal(isFirstAuditGuardActive(null, now), false);
  assert.equal(isFirstAuditGuardActive(now - 1000, now), true);
  assert.equal(isFirstAuditGuardActive(now - 7 * 60 * 1000, now), false);
});
