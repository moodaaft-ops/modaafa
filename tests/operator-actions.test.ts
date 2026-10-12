import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeExtendedTrialEnd,
  createOperatorActionHandler,
  parseOperatorAction,
  type OperatorActionDeps,
} from '../lib/platform/operator-actions';
import { isOperatorUser } from '../lib/platform/operators';
import { NO_OVERRIDES, summarizeOverrides } from '../lib/billing/access-overrides';
import { applyAccessOverrides, getSubscriptionAccess, featureAccessStatus } from '../lib/billing/entitlements';

const OPERATOR = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', email: 'owner@modaafa.com', email_confirmed_at: '2026-09-01T00:00:00Z' };
const TARGET = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NOW = Date.parse('2026-10-12T09:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

type Calls = { audit: any[]; finish: any[]; stripe: any[]; inserts: any[]; revokes: any[]; localTrial: any[] };

function build(overrides: Partial<OperatorActionDeps> = {}) {
  const calls: Calls = { audit: [], finish: [], stripe: [], inserts: [], revokes: [], localTrial: [] };
  const deps: OperatorActionDeps = {
    isSameOrigin: () => true,
    getUser: async () => OPERATOR,
    isOperator: (user) => user.id === OPERATOR.id,
    rateLimit: async () => ({ allowed: true }),
    loadTarget: async (id) => (id === TARGET ? { id: TARGET, email: 'customer@shop.sa' } : null),
    isOperatorEmail: (email) => email === OPERATOR.email,
    readOverrides: async () => NO_OVERRIDES,
    findTrialingSubscription: async () => ({
      id: 'sub-row-1',
      stripeSubscriptionId: 'sub_123',
      trialEndsAt: new Date(NOW + 2 * DAY).toISOString(),
    }),
    startAudit: async (row) => {
      calls.audit.push(row);
      return 'audit-1';
    },
    finishAudit: async (id, outcome) => {
      calls.finish.push({ id, ...outcome });
    },
    extendStripeTrial: async (params) => {
      calls.stripe.push(params);
      // Stripe's live trial end, two days out; the helper extends from it.
      const live = NOW + 2 * DAY;
      return {
        status: 'trialing',
        previousTrialEnd: new Date(live).toISOString(),
        trialEnd: new Date(live + params.days * DAY).toISOString(),
      };
    },
    replacePlanGrant: async (row) => {
      calls.inserts.push({ userId: row.userId, kind: 'plan_grant', plan: row.plan, expiresAt: row.expiresAt, atomic: true });
    },
    updateLocalTrialEnd: async (id, iso) => {
      calls.localTrial.push({ id, iso });
    },
    revokeOverrides: async (userId, kind) => {
      calls.revokes.push({ userId, kind });
      return 1;
    },
    insertOverride: async (row) => {
      calls.inserts.push(row);
    },
    now: () => NOW,
    ...overrides,
  };
  return { handle: createOperatorActionHandler(deps), calls };
}

const confirmBody = (extra: Record<string, unknown>) => ({ confirm: true, reason: 'طلب العميل على الواتساب', ...extra });

// ---------------------------------------------------------------------------
// Who can call it
// ---------------------------------------------------------------------------

test('cross-origin requests are refused before anything is read', async () => {
  let readUser = false;
  const { handle } = build({
    isSameOrigin: () => false,
    getUser: async () => {
      readUser = true;
      return OPERATOR;
    },
  });
  const res = await handle({ targetUserId: TARGET, body: confirmBody({ action: 'suspend' }) });
  assert.equal(res.status, 403);
  assert.equal(readUser, false);
});

test('a signed-out request gets 401', async () => {
  const { handle } = build({ getUser: async () => null });
  const res = await handle({ targetUserId: TARGET, body: confirmBody({ action: 'suspend' }) });
  assert.equal(res.status, 401);
});

test('a normal customer gets 404 and nothing is written, for every action', async () => {
  for (const action of ['extend_trial', 'grant_plan', 'revoke_plan', 'suspend', 'unsuspend']) {
    const { handle, calls } = build({
      getUser: async () => ({ id: TARGET, email: 'customer@shop.sa', email_confirmed_at: '2026-10-01T00:00:00Z' }),
    });
    const res = await handle({ targetUserId: TARGET, body: confirmBody({ action, days: 3, plan: 'pro' }) });
    assert.equal(res.status, 404, action);
    assert.equal(calls.audit.length + calls.stripe.length + calls.inserts.length + calls.revokes.length, 0, action);
  }
});

test('isOperatorUser needs the email on the list AND confirmed, and the id when an id list is set', () => {
  const env = { emails: 'owner@modaafa.com', userIds: '' };
  assert.equal(isOperatorUser(OPERATOR, env), true);
  assert.equal(isOperatorUser({ ...OPERATOR, email_confirmed_at: null }, env), false);
  assert.equal(isOperatorUser({ ...OPERATOR, email: 'someone@else.com' }, env), false);
  assert.equal(isOperatorUser({ ...OPERATOR, email: 'OWNER@modaafa.com' }, env), true);
  assert.equal(isOperatorUser(OPERATOR, { emails: 'owner@modaafa.com', userIds: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }), false);
  assert.equal(isOperatorUser(OPERATOR, { emails: 'owner@modaafa.com', userIds: OPERATOR.id.toUpperCase() }), true);
  assert.equal(isOperatorUser(null, env), false);
  assert.equal(isOperatorUser(OPERATOR, { emails: '', userIds: '' }), false);
});

test('rate limited and limiter-down are both refused', async () => {
  assert.equal((await build({ rateLimit: async () => ({ allowed: false }) }).handle({ targetUserId: TARGET, body: confirmBody({ action: 'suspend' }) })).status, 429);
  assert.equal(
    (
      await build({
        rateLimit: async () => {
          throw new Error('down');
        },
      }).handle({ targetUserId: TARGET, body: confirmBody({ action: 'suspend' }) })
    ).status,
    503
  );
});

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

test('no confirm flag, no reason, bad days or bad plan are 400', () => {
  assert.equal(parseOperatorAction({ action: 'suspend', reason: 'سبب واضح' }).ok, false);
  assert.equal(parseOperatorAction({ action: 'suspend', confirm: true, reason: ' ' }).ok, false);
  assert.equal(parseOperatorAction({ action: 'delete_everything', confirm: true, reason: 'abc' }).ok, false);
  assert.equal(parseOperatorAction({ action: 'extend_trial', confirm: true, reason: 'abc', days: 0 }).ok, false);
  assert.equal(parseOperatorAction({ action: 'extend_trial', confirm: true, reason: 'abc', days: 61 }).ok, false);
  assert.equal(parseOperatorAction({ action: 'extend_trial', confirm: true, reason: 'abc', days: 2.5 }).ok, false);
  assert.equal(parseOperatorAction({ action: 'grant_plan', confirm: true, reason: 'abc', plan: 'enterprise' }).ok, false);
  assert.equal(parseOperatorAction({ action: 'grant_plan', confirm: true, reason: 'abc', plan: 'pro', expiresAt: '2026-10-01' }, NOW).ok, false);
  assert.equal(parseOperatorAction({ action: 'grant_plan', confirm: true, reason: 'abc', plan: 'pro', expiresAt: '2030-01-01' }, NOW).ok, false);
  assert.equal(parseOperatorAction({ action: 'grant_plan', confirm: true, reason: 'abc', plan: 'pro', expiresAt: '2027-02-31' }, NOW).ok, false);
  const ok = parseOperatorAction({ action: 'grant_plan', confirm: true, reason: 'abc', plan: 'growth', expiresAt: '2026-11-30' }, NOW);
  assert.equal(ok.ok, true);
  if (ok.ok && ok.input.action === 'grant_plan') {
    // End of that day in Riyadh.
    assert.equal(ok.input.expiresAt, '2026-11-30T20:59:59.000Z');
  }
});

test('a malformed target id is 400 and an unknown one is 404', async () => {
  assert.equal((await build().handle({ targetUserId: 'not-a-uuid', body: confirmBody({ action: 'suspend' }) })).status, 400);
  assert.equal(
    (await build().handle({ targetUserId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', body: confirmBody({ action: 'suspend' }) })).status,
    404
  );
});

// ---------------------------------------------------------------------------
// Extend trial
// ---------------------------------------------------------------------------

test('extending a trial audits first, asks Stripe for N days, and writes the confirmed end locally', async () => {
  const { handle, calls } = build();
  const res = await handle({ targetUserId: TARGET, body: confirmBody({ action: 'extend_trial', days: 7 }) });
  assert.equal(res.status, 200);
  assert.equal(calls.audit.length, 1);
  assert.equal(calls.audit[0].action, 'extend_trial');
  assert.equal(calls.stripe.length, 1);
  assert.equal(calls.stripe[0].subscriptionId, 'sub_123');
  assert.equal(calls.stripe[0].days, 7);
  assert.equal(calls.localTrial[0].id, 'sub-row-1');
  assert.equal(calls.localTrial[0].iso, new Date(NOW + 9 * DAY).toISOString());
  assert.equal(calls.finish[0].status, 'succeeded');
});

test('Stripe says the subscription is no longer trialing: 409, audit failed, nothing local changes', async () => {
  const { handle, calls } = build({
    extendStripeTrial: async () => {
      throw Object.assign(new Error('subscription is active, not trialing'), { code: 'not_trialing', stripeStatus: 'active' });
    },
  });
  const res = await handle({ targetUserId: TARGET, body: confirmBody({ action: 'extend_trial', days: 7 }) });
  assert.equal(res.status, 409);
  assert.equal(res.json.error, 'not_trialing');
  assert.equal(calls.localTrial.length, 0);
  assert.equal(calls.finish[0].status, 'failed');
});

test('an expired trial end extends from today, not from the past', () => {
  const end = computeExtendedTrialEnd(new Date(NOW - 5 * DAY).toISOString(), 3, NOW);
  assert.equal(end.getTime(), NOW + 3 * DAY);
});

test('no trialing subscription: 409 and nothing is audited or sent to Stripe', async () => {
  const { handle, calls } = build({ findTrialingSubscription: async () => null });
  const res = await handle({ targetUserId: TARGET, body: confirmBody({ action: 'extend_trial', days: 7 }) });
  assert.equal(res.status, 409);
  assert.equal(calls.audit.length, 0);
  assert.equal(calls.stripe.length, 0);
});

test('a Stripe failure is reported and the audit row is marked failed', async () => {
  const { handle, calls } = build({
    extendStripeTrial: async () => {
      throw new Error('No such subscription');
    },
  });
  const res = await handle({ targetUserId: TARGET, body: confirmBody({ action: 'extend_trial', days: 7 }) });
  assert.equal(res.status, 502);
  assert.equal(calls.finish[0].status, 'failed');
  assert.match(calls.finish[0].errorMessage, /No such subscription/);
});

// ---------------------------------------------------------------------------
// Audit is mandatory
// ---------------------------------------------------------------------------

test('when the audit row cannot be written, nothing happens', async () => {
  for (const action of ['extend_trial', 'grant_plan', 'suspend']) {
    const { handle, calls } = build({
      startAudit: async () => {
        throw new Error('relation "operator_audit_log" does not exist');
      },
    });
    const res = await handle({ targetUserId: TARGET, body: confirmBody({ action, days: 3, plan: 'pro' }) });
    assert.equal(res.status, 503, action);
    assert.equal(calls.stripe.length + calls.inserts.length + calls.revokes.length, 0, action);
  }
});

// ---------------------------------------------------------------------------
// Plan grants and suspension
// ---------------------------------------------------------------------------

test('granting a plan goes through the one-transaction replace, never revoke-then-insert', async () => {
  const { handle, calls } = build();
  const res = await handle({ targetUserId: TARGET, body: confirmBody({ action: 'grant_plan', plan: 'growth' }) });
  assert.equal(res.status, 200);
  assert.deepEqual(calls.revokes, []);
  assert.deepEqual(calls.inserts, [{ userId: TARGET, kind: 'plan_grant', plan: 'growth', expiresAt: null, atomic: true }]);
});

test('an operator account cannot be suspended, including your own', async () => {
  const self = build({ loadTarget: async () => ({ id: OPERATOR.id, email: OPERATOR.email }) });
  assert.equal((await self.handle({ targetUserId: OPERATOR.id, body: confirmBody({ action: 'suspend' }) })).status, 400);
  assert.equal(self.calls.inserts.length, 0);
});

test('suspend twice is 409; unsuspend without a suspension is 409', async () => {
  const suspended = build({ readOverrides: async () => ({ ...NO_OVERRIDES, suspended: true, suspendedAt: '2026-10-10T00:00:00Z' }) });
  assert.equal((await suspended.handle({ targetUserId: TARGET, body: confirmBody({ action: 'suspend' }) })).status, 409);
  const lifted = await suspended.handle({ targetUserId: TARGET, body: confirmBody({ action: 'unsuspend' }) });
  assert.equal(lifted.status, 200);
  assert.deepEqual(suspended.calls.revokes, [{ userId: TARGET, kind: 'suspension' }]);
  assert.equal((await build().handle({ targetUserId: TARGET, body: confirmBody({ action: 'unsuspend' }) })).status, 409);
});

test('a concurrent duplicate (unique violation) is a 409, not a 500', async () => {
  const { handle } = build({
    insertOverride: async () => {
      throw Object.assign(new Error('duplicate key'), { code: '23505' });
    },
  });
  assert.equal((await handle({ targetUserId: TARGET, body: confirmBody({ action: 'suspend' }) })).status, 409);
});

// ---------------------------------------------------------------------------
// What the overrides do to entitlements
// ---------------------------------------------------------------------------

test('summarizeOverrides ignores revoked, expired and malformed rows', () => {
  const live = summarizeOverrides(
    [
      { kind: 'plan_grant', plan: 'pro', expires_at: new Date(NOW - DAY).toISOString(), revoked_at: null },
      { kind: 'plan_grant', plan: 'growth', expires_at: null, revoked_at: null },
      { kind: 'suspension', plan: null, revoked_at: '2026-10-01T00:00:00Z' },
      { plan: 'pro', status: 'active' },
    ],
    NOW
  );
  assert.equal(live.suspended, false);
  assert.equal(live.grant?.plan, 'growth');
});

test('a suspension beats a paid plan; a grant only lifts, never lowers', () => {
  const paid = { active: true, plan: 'growth' as const, status: 'active', trialEndsAt: null, currentPeriodEnd: null };
  const suspended = applyAccessOverrides(paid, { ...NO_OVERRIDES, suspended: true });
  assert.equal(suspended.active, false);
  assert.equal(suspended.status, 'suspended');
  assert.equal(suspended.suspended, true);

  const lower = applyAccessOverrides(paid, { ...NO_OVERRIDES, grant: { plan: 'starter', expiresAt: null, grantedAt: null } });
  assert.equal(lower.plan, 'growth');
  assert.equal(lower.status, 'active');

  const higher = applyAccessOverrides(paid, { ...NO_OVERRIDES, grant: { plan: 'pro', expiresAt: null, grantedAt: null } });
  assert.equal(higher.plan, 'pro');
  assert.equal(higher.status, 'comp');

  const none = { active: false, plan: null, status: null, trialEndsAt: null, currentPeriodEnd: null };
  const comp = applyAccessOverrides(none, { ...NO_OVERRIDES, grant: { plan: 'starter', expiresAt: null, grantedAt: null } });
  assert.equal(comp.active, true);
  assert.equal(comp.plan, 'starter');
  assert.equal(featureAccessStatus('account_suspended'), 403);
});

test('getSubscriptionAccess reads overrides per table and survives a missing overrides table', async () => {
  const future = new Date(Date.now() + 10 * DAY).toISOString();
  const tables: Record<string, { data: unknown; error: unknown }> = {
    subscriptions: { data: [{ plan: 'starter', status: 'active', current_period_end: future, created_at: '2026-10-01' }], error: null },
    account_access_overrides: { data: [{ kind: 'suspension', plan: null, expires_at: null, created_at: '2026-10-11', revoked_at: null }], error: null },
  };
  const client = (map: typeof tables) => ({
    from: (table: string) => {
      const builder: any = {
        select: () => builder,
        order: () => builder,
        limit: () => builder,
        eq: () => builder,
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(map[table]).then(resolve),
      };
      return builder;
    },
  });

  const suspended = await getSubscriptionAccess(client(tables), 'user-1');
  assert.equal(suspended.active, false);
  assert.equal(suspended.status, 'suspended');

  const missing = await getSubscriptionAccess(
    client({ ...tables, account_access_overrides: { data: null, error: { code: '42P01', message: 'relation does not exist' } } }),
    'user-1'
  );
  assert.equal(missing.active, true);
  assert.equal(missing.plan, 'starter');
});
