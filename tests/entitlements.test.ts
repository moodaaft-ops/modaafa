import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { budgetCapsFor } from '../lib/ai/usage';
import {
  PLAN_LIMITS,
  consumeFeatureUsage,
  effectiveLimitPlan,
  featureAccessMessage,
  featureAccessStatus,
  usageWindow,
} from '../lib/billing/entitlements';

test('paid plans keep every metered feature explicitly bounded', () => {
  for (const plan of ['starter', 'growth', 'pro'] as const) {
    for (const feature of ['assistant', 'campaign_builder', 'audit', 'manual_sync', 'execute_action'] as const) {
      assert.ok(PLAN_LIMITS[plan][feature].limit > 0, `${plan}.${feature} should have a positive limit`);
    }
  }
});

test('higher plans never reduce a feature limit', () => {
  for (const feature of ['assistant', 'campaign_builder', 'audit', 'manual_sync', 'execute_action'] as const) {
    assert.ok(PLAN_LIMITS.growth[feature].limit >= PLAN_LIMITS.starter[feature].limit);
    assert.ok(PLAN_LIMITS.pro[feature].limit >= PLAN_LIMITS.growth[feature].limit);
  }
});

test('daily usage window resets at UTC midnight', () => {
  const { start, end } = usageWindow('day', new Date('2026-07-16T14:35:00.000Z'));
  assert.equal(start.toISOString(), '2026-07-16T00:00:00.000Z');
  assert.equal(end.toISOString(), '2026-07-17T00:00:00.000Z');
});

test('weekly usage window follows the Saudi work week from Saturday', () => {
  const { start, end } = usageWindow('week', new Date('2026-07-16T14:35:00.000Z'));
  assert.equal(start.toISOString(), '2026-07-11T00:00:00.000Z');
  assert.equal(end.toISOString(), '2026-07-18T00:00:00.000Z');
});

test('monthly usage window resets on the first day of the month', () => {
  const { start, end } = usageWindow('month', new Date('2026-12-31T23:59:59.000Z'));
  assert.equal(start.toISOString(), '2026-12-01T00:00:00.000Z');
  assert.equal(end.toISOString(), '2027-01-01T00:00:00.000Z');
});

test('entitlement errors map to stable HTTP semantics and Arabic guidance', () => {
  assert.equal(featureAccessStatus('subscription_required'), 402);
  assert.equal(featureAccessStatus('quota_exceeded'), 429);
  assert.equal(featureAccessStatus('usage_storage_unavailable'), 503);
  assert.match(featureAccessMessage('subscription_required'), /اشتراك/);
  assert.match(featureAccessMessage('quota_exceeded'), /حد الاستخدام/);
});

// ---------------------------------------------------------------------------
// A trial runs on Starter limits
// ---------------------------------------------------------------------------

const FUTURE = new Date(Date.now() + 10 * 24 * 3600 * 1000).toISOString();
const PAST = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

test('effectiveLimitPlan caps only Stripe trials at starter', () => {
  assert.equal(effectiveLimitPlan({ plan: 'pro', status: 'trialing' }), 'starter');
  assert.equal(effectiveLimitPlan({ plan: 'growth', status: 'trialing' }), 'starter');
  assert.equal(effectiveLimitPlan({ plan: 'starter', status: 'trialing' }), 'starter');
  assert.equal(effectiveLimitPlan({ plan: 'pro', status: 'active' }), 'pro');
  assert.equal(effectiveLimitPlan({ plan: 'growth', status: 'past_due' }), 'growth');
  // An operator free-plan grant and operator internal access are deliberate.
  assert.equal(effectiveLimitPlan({ plan: 'pro', status: 'comp' }), 'pro');
  assert.equal(effectiveLimitPlan({ plan: 'growth', status: 'comp' }), 'growth');
  assert.equal(effectiveLimitPlan({ plan: 'pro', status: 'internal' }), 'pro');
  assert.equal(effectiveLimitPlan({ plan: null, status: null }), null);
  assert.equal(effectiveLimitPlan({ plan: null, status: 'trialing' }), null);
});

/** Just enough of the Supabase client for getSubscriptionAccess + consume_feature_usage. */
function entitlementDatabase({
  subscriptions,
  overrides = [],
}: {
  subscriptions: Array<Record<string, unknown>>;
  overrides?: Array<Record<string, unknown>>;
}) {
  const rpcCalls: Array<{ name: string; args: Record<string, any> }> = [];
  return {
    rpcCalls,
    from(table: string) {
      const rows = table === 'subscriptions' ? subscriptions : overrides;
      const chain: any = {
        select: () => chain,
        order: () => chain,
        limit: () => chain,
        eq: () => chain,
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
          Promise.resolve({ data: rows, error: null }).then(resolve, reject),
      };
      return chain;
    },
    async rpc(name: string, args: Record<string, any>) {
      rpcCalls.push({ name, args });
      return { data: [{ allowed: true, used: 1, event_id: 'usage-event-1' }], error: null };
    },
  };
}

function subscriptionRow(overrides: Record<string, unknown>) {
  return {
    plan: 'pro',
    status: 'active',
    trial_ends_at: null,
    current_period_start: PAST,
    current_period_end: FUTURE,
    created_at: PAST,
    ...overrides,
  };
}

async function limitFor(database: ReturnType<typeof entitlementDatabase>, feature: 'assistant' | 'audit' = 'assistant') {
  const result = await consumeFeatureUsage({
    supabase: database,
    userId: 'user-1',
    userEmail: 'customer@example.com',
    feature,
  });
  assert.equal(result.ok, true);
  return { result, rpc: database.rpcCalls[0].args };
}

test('a trialing Pro subscription is metered at the Starter limits', async () => {
  const database = entitlementDatabase({
    subscriptions: [subscriptionRow({ plan: 'pro', status: 'trialing', trial_ends_at: FUTURE })],
  });
  const { result, rpc } = await limitFor(database);
  assert.equal(rpc.p_limit, PLAN_LIMITS.starter.assistant.limit);
  assert.equal(result.ok && result.limit, PLAN_LIMITS.starter.assistant.limit);
  // The plan reported back is still the one the customer chose.
  assert.equal(result.ok && result.plan, 'pro');
});

test('the Starter cap applies to every metered feature, not just the assistant', async () => {
  const database = entitlementDatabase({
    subscriptions: [subscriptionRow({ plan: 'growth', status: 'trialing', trial_ends_at: FUTURE })],
  });
  const { rpc } = await limitFor(database, 'audit');
  assert.equal(rpc.p_limit, PLAN_LIMITS.starter.audit.limit);
});

test('an active Pro subscription is metered at the Pro limits', async () => {
  const database = entitlementDatabase({ subscriptions: [subscriptionRow({ plan: 'pro', status: 'active' })] });
  const { rpc } = await limitFor(database);
  assert.equal(rpc.p_limit, PLAN_LIMITS.pro.assistant.limit);
});

test('a trial that converted to paid moves to the full limits', async () => {
  const database = entitlementDatabase({
    subscriptions: [subscriptionRow({ plan: 'growth', status: 'active', trial_ends_at: PAST })],
  });
  const { rpc } = await limitFor(database);
  assert.equal(rpc.p_limit, PLAN_LIMITS.growth.assistant.limit);
});

test('an operator free-plan grant keeps its plan limits, even on top of a trial', async () => {
  const database = entitlementDatabase({
    subscriptions: [subscriptionRow({ plan: 'starter', status: 'trialing', trial_ends_at: FUTURE })],
    overrides: [{ kind: 'plan_grant', plan: 'pro', expires_at: null, created_at: PAST, revoked_at: null }],
  });
  const { result, rpc } = await limitFor(database);
  assert.equal(rpc.p_limit, PLAN_LIMITS.pro.assistant.limit);
  assert.equal(result.ok && result.plan, 'pro');
});

test('a trial gets the Starter LLM budget, not the budget of the plan it picked', () => {
  const trialPlan = effectiveLimitPlan({ plan: 'pro', status: 'trialing' });
  assert.deepEqual(
    budgetCapsFor({ plan: trialPlan, subscriptionActive: true }),
    budgetCapsFor({ plan: 'starter', subscriptionActive: true })
  );
  assert.notDeepEqual(
    budgetCapsFor({ plan: 'pro', subscriptionActive: true }),
    budgetCapsFor({ plan: trialPlan, subscriptionActive: true })
  );
});

test('no per-plan limit lookup bypasses effectiveLimitPlan', () => {
  const roots = ['app', 'lib'].map((dir) => resolve(__dirname, '..', dir));
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (/\.(ts|tsx)$/.test(name)) {
        const source = readFileSync(full, 'utf8');
        if (/PLAN_LIMITS\[/.test(source) && !source.includes('effectiveLimitPlan(')) offenders.push(full);
      }
    }
  };
  roots.forEach(walk);
  assert.deepEqual(offenders, []);
  // The LLM budget is plan-keyed too (PLAN_PRICE_SAR): the helper is applied inside
  // lib/ai/usage.ts, so no caller can skip it. Its price table is read in one place only.
  const usage = readFileSync(resolve(__dirname, '..', 'lib/ai/usage.ts'), 'utf8');
  assert.match(usage, /budgetCapsFor\(\{ plan: effectiveLimitPlan\(\{ plan: plan \?\? null, status \}\)/);
  assert.equal((usage.match(/PLAN_PRICE_SAR\[/g) ?? []).length, 1);
});
