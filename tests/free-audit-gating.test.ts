import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { isSubscriptionEntitled } from '../lib/billing/entitlements';
import {
  FREE_AUDITS_PER_ACCOUNT,
  auditAccessMessage,
  auditAccessStatus,
  completeAuditAccess,
  reserveAuditAccess,
} from '../lib/billing/free-audit';

/** In-memory twin of consume_free_audit (db/migrations/20261009_free_audit_quota.sql). */
function fakeSupabase(accountCustomer: Record<string, string> = { acc1: '1234567890', 'brand-new-row': '1234567890', acc9: '9876543210' }) {
  const ledger: { id: string; customer: string; status: string; user?: string; account?: string }[] = [];
  const calls: any[] = [];
  let seq = 0;
  return {
    ledger,
    calls,
    async rpc(name: string, args: any) {
      calls.push({ name, args });
      if (name === 'complete_free_audit') {
        assert.deepEqual(Object.keys(args).sort(), ['p_account_id', 'p_event_id', 'p_user_id']);
        const row = ledger.find((r) => r.id === args.p_event_id && r.user === args.p_user_id && r.account === args.p_account_id);
        if (!row) return { data: 'not_found', error: null };
        if (row.status === 'completed') return { data: 'already_completed', error: null };
        if (row.status === 'abandoned') return { data: 'expired', error: null };
        row.status = 'completed';
        return { data: 'completed', error: null };
      }
      assert.equal(name, 'consume_free_audit');
      assert.deepEqual(Object.keys(args), ['p_account_id'], 'the client sends only the account id');
      const customer = accountCustomer[args.p_account_id] ?? args.p_customer_id;
      const completed = ledger.filter((r) => r.customer === customer && r.status === 'completed').length;
      if (completed >= 2) {
        return { data: [{ allowed: false, reason: 'free_audits_exhausted', used: completed, event_id: null }], error: null };
      }
      if (ledger.some((r) => r.customer === customer && r.status === 'reserved')) {
        return { data: [{ allowed: false, reason: 'audit_in_progress', used: completed, event_id: null }], error: null };
      }
      const id = `evt-${++seq}`;
      ledger.push({ id, customer, status: 'reserved', user: 'u1', account: args.p_account_id });
      return { data: [{ allowed: true, reason: null, used: completed + 1, event_id: id }], error: null };
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
  const other = await reserveAuditAccess({ ...base, accountId: 'acc9', customerId: '9876543210', supabase, deps: deps(inactive) });
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

test('completion is server-side (admin client), verified, and errors are reported, never thrown', async () => {
  const supabase = fakeSupabase();
  const access = await reserveAuditAccess({ ...base, supabase, deps: deps(inactive) });
  const done = (admin: any, over: any = {}) =>
    completeAuditAccess({ admin, userId: 'u1', accountId: 'acc1', access, ...over });
  assert.equal(await done(supabase, { userId: 'u2' }), 'not_found', 'wrong user');
  assert.equal(await done(supabase, { accountId: 'acc9' }), 'not_found', 'wrong account');
  assert.equal(supabase.ledger[0].status, 'reserved');
  assert.equal(await done(supabase), 'completed');
  assert.equal(await done(supabase), 'already_completed');
  const sent = supabase.calls.filter((c: any) => c.name === 'complete_free_audit').pop().args;
  assert.deepEqual(sent, { p_event_id: access.ok && access.source === 'free' ? access.freeEventId : '', p_user_id: 'u1', p_account_id: 'acc1' });
  const broken = { rpc: async () => ({ data: null, error: { message: 'down' } }) };
  assert.equal(await done(broken), 'error');
  const throwing = { rpc: async () => { throw new Error('boom'); } };
  assert.equal(await done(throwing), 'error');
  const sub = { ok: true as const, source: 'subscription' as const, remaining: 1, resetsAt: 'x', usageEventId: 'u' };
  assert.equal(await completeAuditAccess({ admin: broken, userId: 'u1', accountId: 'acc1', access: sub }), 'noop');
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

test('the audit route completes with the admin client after the report is saved', () => {
  const route = readFileSync(new URL('../app/api/audit/run/route.ts', import.meta.url), 'utf8');
  assert.match(route, /completeAuditAccess\(\{ admin, userId: user\.id, accountId: account\.id, access: usage \}\)/);
  assert.ok(route.indexOf('await executeAudit(') < route.indexOf('await completeAuditAccess('), 'completion runs after executeAudit');
  const migration = readFileSync(new URL('../db/migrations/20261009_free_audit_quota.sql', import.meta.url), 'utf8');
  assert.match(migration, /grant execute on function public\.complete_free_audit\(uuid, uuid, uuid\) to service_role;/);
  assert.doesNotMatch(migration, /grant execute on function public\.complete_free_audit[^;]*authenticated;/);
});
