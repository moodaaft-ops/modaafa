import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { loadPlanLock } from '../lib/plan/load';
import { buildPlan, stripPlanCategories, type Plan } from '../lib/plan/plan';
import { PlanLock } from '../lib/plan/plan-lock';
import { LockedHome } from '../app/(dashboard)/home/locked-home';
import { adaptiveLockedPlan, applyAdaptiveLock } from '../lib/setup/adaptive/locked-plan';
import { LATEST_SIGNALS_MAX_AGE_HOURS, loadLatestSignals, loadStoredSignals } from '../lib/setup/adaptive/signals-store';
import { emptyLedger, type LedgerEntries } from '../lib/setup/ledger';
import { eqValue, fakeDb } from './fixtures/fake-db';
import { clinicAccount, readAgo, signalsRow, untrackedAccount } from './fixtures/adaptive-accounts';

// ---------------------------------------------------------------------------
// B1: /home, /optimizer and /audit used to rebuild the plan from the audit
// alone, which undid what the onboarding screen had just shown.
// ---------------------------------------------------------------------------

const NOW = new Date('2026-10-14T10:00:00.000Z');
const BUSINESS = { id: 'biz-1', name: 'عيادة الابتسامة', sector: null, website: null, monthly_budget: null, primary_goal: null, target_regions: [] as string[] };

const rec = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `قرار ${id}`,
  description: `سبب ${id}`,
  severity: 'medium',
  status: 'pending',
  created_at: '2026-10-13T08:00:00.000Z',
  expected_impact: null,
  action_payload: null,
  category: 'keywords',
  ...extra,
});

const AUDIT = { health_score: 58, estimated_monthly_waste: 1840, ran_at: '2026-10-13T07:00:00.000Z' };
const RECS = [
  rec('a', { severity: 'critical', category: 'keywords', expected_impact: { metric: 'cost', delta_sar_per_month: 412 } }),
  rec('b', { category: 'bidding' }),
  rec('c', { category: 'ads' }),
];

function auditPlan(): Plan {
  return buildPlan({
    audit: AUDIT,
    recommendations: RECS.map((row) => ({ ...row, executable: false })),
    currency: 'SAR',
    includeCategory: true,
  });
}

const ENV_ON = { CHAT_FIRST_ENTRY: 'true', ADAPTIVE_ONBOARDING: 'true' };
const ENV_OFF = { CHAT_FIRST_ENTRY: 'true' };

function ledgerWith(choices: Array<[string, string]> = []): LedgerEntries {
  const ledger = emptyLedger();
  for (const [key, choice] of choices) ledger.choices.set(key as never, choice);
  return ledger;
}

const wireKeys = (value: unknown) => JSON.stringify(value);

test('B1: a tracking state puts the rules decision first and the audit decision behind it, with no waste', () => {
  const plan = auditPlan();
  const result = applyAdaptiveLock({
    plan,
    signals: untrackedAccount({ readAt: NOW.toISOString() }),
    ledger: ledgerWith(),
    business: BUSINESS,
  });
  assert.equal(result.lead?.id, 'tracking_setup');
  assert.equal(result.plan.first, null, 'the open slot belongs to the rules decision');
  assert.deepEqual(
    result.plan.locked.map((row) => row.id),
    ['a', 'b', 'c'],
    'the audit decision that was open moves to the top of the locked list'
  );
  assert.equal(result.plan.decisionsCount, 3, 'the count stays what the audit found');
  assert.equal(result.plan.waste, null, 'a number for an account that cannot say what its ads bring is not shown');
  assert.equal(result.firstWhy, null, 'a rules decision replaces the audit one, so there is nothing to explain under it');
  // The locked rows carry only id, title and severity: no reason, no amount, no category.
  for (const row of result.plan.locked) assert.deepEqual(Object.keys(row).sort(), ['id', 'severity', 'title']);
  assert.equal(wireKeys(result).includes('"category"'), false);
  assert.equal(wireKeys(result.plan).includes('سبب a'), false, 'the audit reason of a locked decision stays on the server');
});

test('B1: a tracking state with the old plan unchanged would show the open audit decision and the waste (the bug this fixes)', () => {
  // What the lock showed before: the plan exactly as the audit built it.
  const before = stripPlanCategories(auditPlan());
  assert.equal(before.first?.id, 'a');
  assert.equal(before.waste, 1840);
  const after = applyAdaptiveLock({ plan: auditPlan(), signals: untrackedAccount({ readAt: NOW.toISOString() }), ledger: ledgerWith(), business: BUSINESS });
  assert.notEqual(after.plan.first?.id, 'a');
  assert.notEqual(after.plan.waste, 1840);
});

test('B1: an active account with a known kind keeps the audit decision open and explains why it is first', () => {
  const result = applyAdaptiveLock({
    plan: auditPlan(),
    signals: clinicAccount({ readAt: NOW.toISOString() }),
    ledger: ledgerWith([['pain', 'clinic_few_calls']]),
    business: BUSINESS,
  });
  assert.equal(result.lead, null);
  assert.equal(result.plan.first?.id, 'a');
  assert.equal(result.plan.waste, 1840, 'tracking works, so the audit number stands');
  assert.match(result.firstWhy ?? '', /^لأنك قلت «الاتصالات قليلة»/);
  assert.equal(wireKeys(result.plan).includes('"category"'), false);
});

test('B1: no stored read gives the plan back as it was, categories stripped, with nothing added', () => {
  const plan = auditPlan();
  const result = applyAdaptiveLock({ plan, signals: null, ledger: ledgerWith(), business: BUSINESS });
  assert.deepEqual(result, { plan: stripPlanCategories(plan), lead: null, firstWhy: null });
  assert.equal(result.plan.first?.id, 'a');
  assert.equal(result.plan.waste, 1840);
});

test('B1: the read may be up to 30 days old for the lock, while onboarding still trusts only 24 hours', async () => {
  const fresh = untrackedAccount({ readAt: NOW.toISOString() });
  const aged = (days: number) => signalsRow(readAgo(fresh, NOW, days * 24));

  // 29 days old: the lock still stands on it.
  const admin29 = fakeDb({ job_runs: [aged(29)] });
  const used = await adaptiveLockedPlan({ admin: admin29.client, accountId: 'acc-1', business: BUSINESS, plan: auditPlan(), ledger: ledgerWith(), now: NOW });
  assert.equal(used.lead?.id, 'tracking_setup');
  assert.equal(used.plan.waste, null);

  // 31 days old: nothing is known, the plan is as it always was.
  const admin31 = fakeDb({ job_runs: [aged(31)] });
  const stale = await adaptiveLockedPlan({ admin: admin31.client, accountId: 'acc-1', business: BUSINESS, plan: auditPlan(), ledger: ledgerWith(), now: NOW });
  assert.equal(stale.lead, null);
  assert.equal(stale.plan.first?.id, 'a');
  assert.equal(stale.plan.waste, 1840);

  // The same 29 day old read is not good for the onboarding questions.
  assert.equal(await loadStoredSignals(admin29.client, 'acc-1', NOW), null);
  assert.ok(await loadLatestSignals(admin29.client, 'acc-1', { maxAgeHours: LATEST_SIGNALS_MAX_AGE_HOURS, now: NOW }));
  // It reads the newest stored read of exactly this linked account, and only a finished one.
  const read = admin29.reads().find((query) => query.table === 'job_runs');
  assert.equal(eqValue(read!, 'job_name'), 'onboarding_signals:acc-1');
});

test('B1: a failed read of the stored signals, or no service client, leaves the plan untouched', async () => {
  const broken = fakeDb({ job_runs: { error: 'boom' } });
  const a = await adaptiveLockedPlan({ admin: broken.client, accountId: 'acc-1', business: BUSINESS, plan: auditPlan(), ledger: ledgerWith(), now: NOW });
  assert.equal(a.lead, null);
  assert.equal(a.plan.waste, 1840);
  const b = await adaptiveLockedPlan({ admin: null, accountId: 'acc-1', business: BUSINESS, plan: auditPlan() });
  assert.equal(b.lead, null);
  assert.equal(b.plan.first?.id, 'a');
  assert.equal(wireKeys(b.plan).includes('"category"'), false);
});

// ---------------------------------------------------------------------------
// loadPlanLock: the real entry /optimizer and /audit call
// ---------------------------------------------------------------------------

function lockTables(signals: ReturnType<typeof signalsRow> | null, memory: unknown[] = []) {
  const rls = fakeDb({
    audits: [AUDIT],
    recommendations: RECS,
    businesses: [BUSINESS],
    // A trial already used: the checkout read settles without asking the service client anything.
    billing_trial_grants: [{ user_id: 'u1' }],
  });
  const admin = fakeDb({ job_runs: signals ? [signals] : [], business_memory: memory });
  return { rls, admin };
}

test('B1: loadPlanLock with the flag on returns the corrected plan and the lead', async () => {
  const { rls, admin } = lockTables(signalsRow(untrackedAccount({ readAt: NOW.toISOString() })));
  const lock = await loadPlanLock(
    rls.client,
    { accountId: 'acc-1', currency: 'SAR', userId: 'u1', userEmail: 'owner@example.com' },
    { env: ENV_ON, admin: admin.client, now: NOW }
  );
  assert.equal(lock.lead?.id, 'tracking_setup');
  assert.equal(lock.plan.first, null);
  assert.equal(lock.plan.waste, null);
  assert.equal(lock.plan.locked[0].id, 'a');
  assert.equal(wireKeys(lock).includes('"category"'), false, 'no audit category goes to the browser');
});

test('B1: loadPlanLock with the flag on and no read in 30 days is the plan of today, plus the empty lead fields', async () => {
  const { rls, admin } = lockTables(null);
  const lock = await loadPlanLock(
    rls.client,
    { accountId: 'acc-1', currency: 'SAR', userId: 'u1', userEmail: 'owner@example.com' },
    { env: ENV_ON, admin: admin.client, now: NOW }
  );
  assert.equal(lock.lead, null);
  assert.equal(lock.firstWhy, null);
  assert.equal(lock.plan.first?.id, 'a');
  assert.equal(lock.plan.waste, 1840);
});

test('B1: loadPlanLock with the flag off reads nothing adaptive and returns the same keys as before', async () => {
  const { rls, admin } = lockTables(signalsRow(untrackedAccount({ readAt: NOW.toISOString() })));
  const lock = await loadPlanLock(
    rls.client,
    { accountId: 'acc-1', currency: 'SAR', userId: 'u1', userEmail: 'owner@example.com' },
    { env: ENV_OFF, admin: admin.client, now: NOW }
  );
  assert.deepEqual(Object.keys(lock).sort(), ['cta', 'plan', 'trialEligible']);
  assert.equal(lock.plan.first?.id, 'a', 'the audit decision stays open');
  assert.equal(lock.plan.waste, 1840);
  assert.equal(admin.queries.length, 0, 'the service client is not touched');
  assert.equal(rls.queries.some((query) => query.table === 'businesses'), false, 'and neither is the business');
  assert.equal(wireKeys(lock.plan).includes('"category"'), false);
});

// --- the screens pass the lead through to the card ---------------------------

// The components are written for Next's automatic JSX runtime; tsx compiles them with the classic one.
(globalThis as unknown as { React: unknown }).React = React;

const lockedFor = (signals: Parameters<typeof applyAdaptiveLock>[0]['signals']) =>
  applyAdaptiveLock({ plan: auditPlan(), signals, ledger: ledgerWith(), business: BUSINESS });

test('B1: /optimizer and /audit (PlanLock) show the rules decision open and the audit decision as a closed row, with no waste', () => {
  const locked = lockedFor(untrackedAccount({ readAt: NOW.toISOString() }));
  assert.ok(locked.lead);
  const out = renderToStaticMarkup(
    React.createElement(PlanLock, { plan: locked.plan, trialEligible: true, lead: locked.lead, firstWhy: locked.firstWhy })
  );
  assert.ok(out.includes(locked.lead.title) && out.includes(locked.lead.reason), 'the rules decision is the open one');
  assert.ok(out.includes('قرار a'), 'the audit decision is still listed');
  assert.ok(!out.includes('سبب a'), 'but it is no longer open next to the rules decision');
  assert.ok(!out.includes('تروح بدون فايدة كل شهر'), 'no waste number for an account without tracking');

  // The same screen without what loadPlanLock now returns is the bug: two open decisions and the number.
  const raw = renderToStaticMarkup(React.createElement(PlanLock, { plan: stripPlanCategories(auditPlan()), trialEligible: true }));
  assert.ok(raw.includes('سبب a') && raw.includes('تروح بدون فايدة كل شهر'));
});

test('B1: /home (LockedHome) shows the same plan as the screens and the setup', () => {
  const locked = lockedFor(untrackedAccount({ readAt: NOW.toISOString() }));
  assert.ok(locked.lead);
  const props = { trialEligible: true, suspended: false, greeting: 'هلا', voiceEnabled: false };
  const out = renderToStaticMarkup(React.createElement(LockedHome, { ...props, plan: locked.plan, lead: locked.lead, firstWhy: locked.firstWhy }));
  assert.ok(out.includes(locked.lead.title) && !out.includes('سبب a') && !out.includes('تروح بدون فايدة كل شهر'));

  const active = lockedFor(clinicAccount({ readAt: NOW.toISOString() }));
  const withWhy = renderToStaticMarkup(React.createElement(LockedHome, { ...props, plan: active.plan, lead: active.lead, firstWhy: 'لأنك قلت كذا' }));
  assert.ok(withWhy.includes('سبب a') && withWhy.includes('لأنك قلت كذا'), 'an active account keeps the audit decision open and says why');
});
