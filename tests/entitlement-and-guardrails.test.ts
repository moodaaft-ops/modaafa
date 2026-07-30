import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getSubscriptionAccess,
  isSubscriptionEntitled,
} from '../lib/billing/entitlements';
import { checkGuardrails, type OptimizerAction } from '../lib/ai/optimizer-agent';

/**
 * Minimal PostgREST-shaped stub. The real builder is thenable AND chainable at
 * every step (`.limit(...)` is awaited in some call sites and further filtered
 * in others), so the stub has to be too.
 */
function subscriptionsStub(rows: Array<Record<string, any>>) {
  const builder: any = {
    select: () => builder,
    order: () => builder,
    limit: () => builder,
    eq: () => builder,
    in: () => builder,
    not: () => builder,
    maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
    then: (resolve: (value: { data: unknown; error: null }) => unknown) =>
      Promise.resolve({ data: rows, error: null }).then(resolve),
  };
  return { from: () => builder };
}

const day = 24 * 60 * 60 * 1000;
const future = new Date(Date.now() + 10 * day).toISOString();
const past = new Date(Date.now() - day).toISOString();

// ---------------------------------------------------------------------------
// Entitlement selection
// ---------------------------------------------------------------------------

test('a cancelled duplicate row does not lock out a still-paying customer', async () => {
  // Selecting "the newest row" meant that cancelling a duplicate subscription
  // (which the double-checkout race could create) revoked access from an
  // account that was still being billed.
  const access = await getSubscriptionAccess(
    subscriptionsStub([
      { plan: 'growth', status: 'canceled', current_period_end: future, created_at: '2026-07-20' },
      { plan: 'growth', status: 'active', current_period_end: future, created_at: '2026-07-01' },
    ]),
    'user-1'
  );

  assert.equal(access.active, true);
  assert.equal(access.plan, 'growth');
});

test('the most privileged live plan wins when several are live', async () => {
  const access = await getSubscriptionAccess(
    subscriptionsStub([
      { plan: 'starter', status: 'active', current_period_end: future, created_at: '2026-07-20' },
      { plan: 'pro', status: 'active', current_period_end: future, created_at: '2026-07-01' },
    ]),
    'user-1'
  );

  assert.equal(access.plan, 'pro');
});

test('past_due keeps access until the paid period actually ends', async () => {
  // Stripe dunns a card for days. Revoking on the first failed retry locked
  // out customers who were still paying and still recoverable.
  const during = await getSubscriptionAccess(
    subscriptionsStub([
      { plan: 'growth', status: 'past_due', current_period_end: future, created_at: '2026-07-01' },
    ]),
    'user-1'
  );
  assert.equal(during.active, true);

  const after = await getSubscriptionAccess(
    subscriptionsStub([
      { plan: 'growth', status: 'past_due', current_period_end: past, created_at: '2026-07-01' },
    ]),
    'user-1'
  );
  assert.equal(after.active, false);
});

test('scheduled jobs use the same entitlement rule for past_due subscriptions', () => {
  assert.equal(
    isSubscriptionEntitled(
      { status: 'past_due', current_period_end: '2026-08-01T00:00:00.000Z' },
      new Date('2026-07-30T00:00:00.000Z').getTime()
    ),
    true
  );
  assert.equal(
    isSubscriptionEntitled(
      { status: 'past_due', current_period_end: '2026-07-29T00:00:00.000Z' },
      new Date('2026-07-30T00:00:00.000Z').getTime()
    ),
    false
  );
});

test('an expired trial and a cancelled subscription both deny access', async () => {
  const expiredTrial = await getSubscriptionAccess(
    subscriptionsStub([
      { plan: 'starter', status: 'trialing', trial_ends_at: past, created_at: '2026-07-01' },
    ]),
    'user-1'
  );
  assert.equal(expiredTrial.active, false);

  const cancelled = await getSubscriptionAccess(
    subscriptionsStub([
      { plan: 'pro', status: 'canceled', current_period_end: future, created_at: '2026-07-01' },
    ]),
    'user-1'
  );
  assert.equal(cancelled.active, false);
  assert.equal(cancelled.status, 'canceled');
});

test('no subscription rows means no access', async () => {
  const access = await getSubscriptionAccess(subscriptionsStub([]), 'user-1');
  assert.equal(access.active, false);
  assert.equal(access.plan, null);
});

// ---------------------------------------------------------------------------
// Bid guardrails
// ---------------------------------------------------------------------------

function bidAction(params: Record<string, unknown>): OptimizerAction {
  return {
    type: 'adjust_bid',
    target_id: 'customers/1/adGroups/2',
    params,
    reason_ar: 'اختبار',
    reason_en: 'test',
    expected_impact: { metric: 'cpa', delta_pct: 0, delta_sar_per_month: 0 },
  };
}

const noopSupabase: any = { from: () => ({ select: () => ({}) }) };

test('a bid change inside ±20% is allowed', async () => {
  const action = bidAction({ current_target_cpa_micros: 100_000_000, target_cpa_micros: 115_000_000 });
  assert.notEqual(await checkGuardrails(action, 'account-1', noopSupabase), null);
});

test('a collapse-delivery bid is blocked', async () => {
  // `target_cpa_micros: 1` is a structurally valid mutation, so validateOnly
  // passes it. Only a numeric guardrail stops it.
  const action = bidAction({ current_target_cpa_micros: 100_000_000, target_cpa_micros: 1 });
  assert.equal(await checkGuardrails(action, 'account-1', noopSupabase), null);
});

test('a runaway bid increase is blocked', async () => {
  const action = bidAction({ current_target_cpa_micros: 100_000_000, target_cpa_micros: 900_000_000 });
  assert.equal(await checkGuardrails(action, 'account-1', noopSupabase), null);
});

test('bid guardrails fail closed when the current target is unknown', async () => {
  const action = bidAction({ target_cpa_micros: 120_000_000 });
  assert.equal(await checkGuardrails(action, 'account-1', noopSupabase), null);
});

test('a non-positive target is always rejected', async () => {
  const action = bidAction({ current_target_cpa_micros: 100_000_000, target_cpa_micros: 0 });
  assert.equal(await checkGuardrails(action, 'account-1', noopSupabase), null);
});

test('target ROAS respects the same bound', async () => {
  const ok = bidAction({ current_target_roas: 4, target_roas: 4.5 });
  assert.notEqual(await checkGuardrails(ok, 'account-1', noopSupabase), null);

  const bad = bidAction({ current_target_roas: 4, target_roas: 0.001 });
  assert.equal(await checkGuardrails(bad, 'account-1', noopSupabase), null);
});
