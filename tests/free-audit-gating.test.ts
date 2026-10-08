import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { isSubscriptionEntitled } from '../lib/billing/entitlements';
import {
  FREE_AUDITS_PER_ACCOUNT,
  auditAccessMessage,
  auditAccessStatus,
  reserveAuditAccess,
} from '../lib/billing/free-audit';

/** In-memory twin of consume_free_audit (db/migrations/20261009_free_audit_quota.sql). */
function fakeSupabase() {
  const ledger: { id: string; customer: string; status: string }[] = [];
  let seq = 0;
  return {
    ledger,
    async rpc(name: string, args: any) {
      assert.equal(name, 'consume_free_audit');
      // The real function takes an advisory lock; the single-threaded twin
      // evaluates each call atomically, which is the same observable contract.
      const rows = ledger.filter((r) => r.customer === args.p_customer_id);
      if (rows.length >= args.p_limit) {
        return { data: [{ allowed: false, reason: 'free_audits_exhausted', used: rows.length, event_id: null }], error: null };
      }
      if (rows.some((r) => r.status === 'reserved')) {
        return { data: [{ allowed: false, reason: 'audit_in_progress', used: rows.length, event_id: null }], error: null };
      }
      const id = `evt-${++seq}`;
      ledger.push({ id, customer: args.p_customer_id, status: 'reserved' });
      return { data: [{ allowed: true, reason: null, used: rows.length + 1, event_id: id }], error: null };
    },
  };
}

const inactive = { active: false, plan: null, status: null, trialEndsAt: null, currentPeriodEnd: null };
const subscribed = { ...inactive, active: true, plan: 'starter' as const, status: 'active' };

function deps(access: typeof inactive | typeof subscribed, spy: string[] = []) {
  return {
    getSubscriptionAccess: async () => access as any,
    consumeFeatureUsage: async (input: any) => {
      spy.push(input.feature);
      return { ok: true as const, plan: 'starter' as const, limit: 10, used: 1, remaining: 9, resetsAt: 'x', usageEventId: 'sub-1' };
    },
  };
}

const base = { userId: 'u1', userEmail: 'a@b.c', accountId: 'acc1', customerId: '1234567890' };

test('free user gets exactly two audits per Google account, then free_audits_exhausted', async () => {
  const supabase = fakeSupabase();
  const first = await reserveAuditAccess({ ...base, supabase, deps: deps(inactive) });
  assert.ok(first.ok && first.source === 'free' && first.remaining === 1);
  supabase.ledger[0].status = 'completed';
  const retry = await reserveAuditAccess({ ...base, supabase, deps: deps(inactive) });
  assert.ok(retry.ok && retry.source === 'free' && retry.remaining === 0);
  supabase.ledger[1].status = 'completed';
  const third = await reserveAuditAccess({ ...base, supabase, deps: deps(inactive) });
  assert.deepEqual(third, { ok: false, reason: 'free_audits_exhausted' });
  assert.equal(FREE_AUDITS_PER_ACCOUNT, 2);
});

test('retry spam while an audit is running is refused without spending the allowance', async () => {
  const supabase = fakeSupabase();
  await reserveAuditAccess({ ...base, supabase, deps: deps(inactive) });
  const spam = await Promise.all(Array.from({ length: 8 }, () => reserveAuditAccess({ ...base, supabase, deps: deps(inactive) })));
  assert.ok(spam.every((r) => !r.ok && r.reason === 'audit_in_progress'));
  assert.equal(supabase.ledger.length, 1);
});

test('relinking or another login on the same Google account does not reset the allowance', async () => {
  const supabase = fakeSupabase();
  for (let i = 0; i < 2; i++) {
    const r = await reserveAuditAccess({ ...base, supabase, deps: deps(inactive) });
    assert.ok(r.ok);
    supabase.ledger[i].status = 'completed';
  }
  const relinked = await reserveAuditAccess({ ...base, accountId: 'brand-new-row', userId: 'u2', supabase, deps: deps(inactive) });
  assert.equal(relinked.ok, false);
  const other = await reserveAuditAccess({ ...base, customerId: '9876543210', supabase, deps: deps(inactive) });
  assert.ok(other.ok, 'a different Google account has its own allowance');
});

test('subscribed users use the plan allowance and never touch the free ledger', async () => {
  const supabase = fakeSupabase();
  const spy: string[] = [];
  const r = await reserveAuditAccess({ ...base, supabase, deps: deps(subscribed, spy) });
  assert.ok(r.ok && r.source === 'subscription');
  assert.deepEqual(spy, ['audit']);
  assert.equal(supabase.ledger.length, 0);
});

test('expired and cancelled subscriptions fall back to the free allowance, not to a hard block', () => {
  const now = Date.parse('2026-10-09T00:00:00Z');
  assert.equal(isSubscriptionEntitled({ status: 'canceled' }, now), false);
  assert.equal(isSubscriptionEntitled({ status: 'trialing', trial_ends_at: '2026-10-01T00:00:00Z' }, now), false);
  assert.equal(isSubscriptionEntitled({ status: 'active', current_period_end: '2026-09-01T00:00:00Z' }, now), false);
  // Scheduled cancel (cancel_at_period_end) still entitles until the period ends.
  assert.equal(isSubscriptionEntitled({ status: 'active', current_period_end: '2026-10-20T00:00:00Z' }, now), true);
});

test('storage errors fail closed with a retryable reason', async () => {
  const supabase = { rpc: async () => ({ data: null, error: { message: 'down' } }) };
  const r = await reserveAuditAccess({ ...base, supabase, deps: deps(inactive) });
  assert.deepEqual(r, { ok: false, reason: 'usage_storage_unavailable' });
  assert.equal(auditAccessStatus('usage_storage_unavailable'), 503);
});

test('exhausted state is a 402 that tells the customer reports stay readable', () => {
  assert.equal(auditAccessStatus('free_audits_exhausted'), 402);
  assert.equal(auditAccessStatus('audit_in_progress'), 409);
  assert.match(auditAccessMessage('free_audits_exhausted')!, /تبقى مفتوحة للقراءة/);
});

// Direct API / cron / webhook: every write path keeps its server-side gate.
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('apply route checks the subscription before any Google Ads call and reserves execute_action', () => {
  const src = read('app/api/recommendations/action/route.ts');
  assert.ok(src.indexOf('getSubscriptionAccess(') < src.indexOf('executeAction(safe, customer'));
  assert.ok(src.includes("feature: 'execute_action'"));
  assert.ok(src.includes('approve_before_execution'), 'customer approval stays required');
});

test('autopilot cron only touches billable businesses and reserves execute_action per action', () => {
  const src = read('app/api/cron/optimize/route.ts');
  assert.ok(src.includes('getBillableBusinessIds'));
  assert.ok(src.indexOf("feature: 'execute_action'") < src.indexOf('executeAutopilotAction({'));
});

test('enabling automatic changes needs an active subscription; monitoring mode does not', () => {
  const src = read('app/api/autopilot/settings/route.ts');
  assert.match(src, /input\.mode === 'conservative' && !access\.active/);
});

test('audit route reads without a plan and rollback stays available after a subscription ends', () => {
  const audit = read('app/api/audit/run/route.ts');
  assert.ok(audit.includes('reserveAuditAccess('));
  assert.ok(!audit.includes("feature: 'audit'"), 'audit no longer demands a subscription directly');
  assert.ok(!read('app/api/actions/rollback/route.ts').includes('consumeFeatureUsage('));
});
