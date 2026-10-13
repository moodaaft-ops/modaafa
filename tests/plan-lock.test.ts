import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { loadPlanLock } from '../lib/plan/load';
import { PLAN_COPY } from '../lib/plan/plan';
import { firstFindings, type OpportunityRow } from '../lib/onboarding/first-opportunities';

const read = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8');
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// A decision list with a secret in every field a locked decision must not show.
const recommendations = [
  {
    id: 'r1',
    title: 'أوقف كلمة تصرف ولا تبيع',
    description: 'السبب الأول المفتوح',
    severity: 'critical',
    status: 'pending',
    expected_impact: { metric: 'cost', delta_sar_per_month: 910 },
    action_payload: { operation: 'pause_keyword', evidence_ar: ['دليل الأول'] },
    created_at: '2026-10-14T09:00:00Z',
  },
  {
    id: 'r2',
    title: 'اخفض ميزانية حملة الشبكة',
    description: 'السبب السري الثاني',
    severity: 'medium',
    status: 'pending',
    expected_impact: { metric: 'cost', delta_sar_per_month: 777 },
    action_payload: { operation: 'adjust_budget', evidence_ar: ['دليل سري ثاني'] },
    created_at: '2026-10-14T08:00:00Z',
  },
  {
    id: 'r3',
    title: 'أضف كلمات سلبية',
    description: 'السبب السري الثالث',
    severity: 'medium',
    status: 'pending',
    expected_impact: { metric: 'cost', delta_sar_per_month: 555 },
    action_payload: { operation: 'add_negative_keyword', evidence_ar: ['دليل سري ثالث'] },
    created_at: '2026-10-14T07:00:00Z',
  },
];

function fakeSupabase(opts: { subscription?: { status: string; stripe_subscription_id: string } | null } = {}) {
  const reads: string[] = [];
  const client = {
    from(table: string) {
      reads.push(table);
      const chain: any = {};
      for (const name of ['select', 'eq', 'in', 'is', 'not', 'gte', 'lte', 'neq', 'order', 'limit', 'contains', 'or']) chain[name] = () => chain;
      const data =
        table === 'audits'
          ? { health_score: 55, estimated_monthly_waste: 1840, ran_at: '2026-10-14T06:00:00Z' }
          : table === 'recommendations'
            ? recommendations
            : table === 'subscriptions'
              ? opts.subscription ?? null
              : null;
      const result = { data, error: null };
      chain.maybeSingle = () => Promise.resolve(result);
      chain.single = () => Promise.resolve(result);
      chain.then = (resolve: any, reject: any) => Promise.resolve({ data: Array.isArray(data) ? data : data ? [data] : [], error: null }).then(resolve, reject);
      return chain;
    },
  };
  return { client, reads };
}

test('the lock keeps the first decision open and sends the others as titles only', async () => {
  const { client } = fakeSupabase();
  const lock = await loadPlanLock(client, { accountId: 'acc', currency: 'SAR', userId: 'u', userEmail: 'u@example.com' });
  assert.equal(lock.plan.kind, 'ready');
  assert.equal(lock.plan.first?.id, 'r1');
  assert.equal(lock.plan.first?.reason, 'السبب الأول المفتوح');
  assert.equal(lock.plan.waste, 1840);
  assert.deepEqual(lock.plan.locked.map((row) => Object.keys(row).sort()), [['id', 'severity', 'title'], ['id', 'severity', 'title']]);
  // Everything that reaches the browser: nothing of the locked decisions beyond their titles.
  const wire = JSON.stringify(lock);
  for (const secret of ['السبب السري الثاني', 'السبب السري الثالث', 'دليل سري', '777', '555', 'adjust_budget', 'add_negative_keyword']) {
    assert.ok(!wire.includes(secret), secret);
  }
  assert.ok(wire.includes('اخفض ميزانية حملة الشبكة') && wire.includes('أضف كلمات سلبية'), 'the titles are shown');
});

test('the lock carries the same CTA /home shows: the checkout entry, or /billing for a stopped subscription', async () => {
  const fresh = await loadPlanLock(fakeSupabase().client, { accountId: 'acc', userId: 'u' });
  assert.equal(fresh.cta.href, '/onboarding/trial');
  assert.equal(fresh.cta.kind === 'trial' || fresh.cta.kind === 'subscribe', true);

  const stopped = await loadPlanLock(
    fakeSupabase({ subscription: { status: 'past_due', stripe_subscription_id: 'sub_1' } }).client,
    { accountId: 'acc', userId: 'u' }
  );
  assert.equal(stopped.cta.kind, 'billing');
  assert.equal(stopped.cta.href, '/billing');
  assert.equal(stopped.cta.label, 'حدّث بطاقتك وكمّل');
  assert.equal(stopped.cta.reason, 'اشتراكك موقوف لأن آخر دفعة ما مرت.');
});

test('a suspended account reads no checkout state and gets no button', async () => {
  const { client, reads } = fakeSupabase();
  const lock = await loadPlanLock(client, { accountId: 'acc', userId: 'u', suspended: true });
  assert.equal(lock.trialEligible, false);
  assert.ok(!reads.includes('subscriptions'), 'no billing read for a suspended account');
  // The view shows the suspension line, not a button (checked on the source below).
  assert.equal(PLAN_COPY.suspendedLine, 'حسابك موقوف مؤقتاً. كلمنا على الواتساب ونرتبه معك.');
});

test('/audit returns the lock before it reads the recommendations, the AI narrative and the report', () => {
  const page = read('app/(dashboard)/audit/page.tsx');
  const gateAt = page.indexOf('if (!hasProductAccess(subscription) && selectedAccount)');
  assert.ok(gateAt > 0);
  assert.ok(gateAt < page.indexOf(".from('recommendations')"), 'the lock comes first');
  assert.ok(gateAt < page.indexOf(".from('reports')"));
  const lockBranch = page.slice(gateAt, page.indexOf('const [recommendationsResult'));
  assert.match(lockBranch, /loadPlanLock\(supabase,/);
  assert.match(lockBranch, /<PlanLock/);
  assert.match(lockBranch, /return \(/);
  // Nothing of the full page renders inside the lock.
  assert.doesNotMatch(lockBranch, /aiNarrative|GuidedNextStep|remainingRecs|latestReport/);
  // The old free-reading promise is gone from the copy.
  assert.doesNotMatch(page, /تبقى مفتوحة للقراءة/);
  assert.doesNotMatch(page, /!subscription\.active && <SubscriptionGate compact/);
});

test('/optimizer shows the lock, reads only id and status of recommendations without access, and keeps the undo', () => {
  const page = strip(read('app/(dashboard)/optimizer/page.tsx'));
  assert.match(page, /const locked = !hasProductAccess\(subscription\)/);
  assert.match(page, /locked\s*\?\s*'id, status'/);
  assert.match(page, /locked \? \(\s*lock \? \(\s*<PlanLock/);
  // The execution log and its rollback form are outside the lock: undoing is never gated.
  const logAt = page.indexOf('id="execution-log"');
  const lockAt = page.indexOf('<PlanLock');
  assert.ok(logAt > lockAt);
  assert.match(page.slice(logAt), /action="\/api\/actions\/rollback"/);
  assert.doesNotMatch(page.slice(logAt), /\blocked\b/);
  assert.doesNotMatch(page, /<SubscriptionGate compact/);
});

test('the setup state carries no amounts for someone without access, and the same top three for someone with it', () => {
  const rows: OpportunityRow[] = [
    { id: 'a', title: 'أ', severity: 'medium', expected_impact: { metric: 'cost', delta_sar_per_month: 100 } },
    { id: 'b', title: 'ب', severity: 'critical', expected_impact: { metric: 'cost', delta_sar_per_month: 900 } },
    { id: 'c', title: 'ج', severity: 'medium', expected_impact: { metric: 'revenue', delta_sar_per_month: 300 } },
    { id: 'd', title: 'د', severity: 'growth', expected_impact: { metric: 'revenue', delta_sar_per_month: 50 } },
  ];
  const locked = firstFindings(rows, false);
  assert.deepEqual(locked.map((f) => f.id), ['b', 'c', 'a']);
  for (const finding of locked) {
    assert.equal(finding.impactLabel, null);
    assert.equal(finding.impactAmount, 0);
  }
  assert.ok(!JSON.stringify(locked).includes('900'));
  const open = firstFindings(rows, true);
  assert.deepEqual(open.map((f) => [f.id, f.impactAmount]), [['b', 900], ['c', 300], ['a', 100]]);
  assert.equal(open[0].impactLabel, 'توفير متوقع شهرياً');
  const load = read('lib/setup/load.ts');
  assert.match(load, /findings = firstFindings\(rows, hasProductAccess\(access\)\)/);
});

test('the lock view gives a suspended account the suspension line and no button', () => {
  const view = strip(read('lib/plan/plan-lock.tsx'));
  assert.match(view, /suspended \? \(\s*<p[^>]*>\{PLAN_COPY\.suspendedLine\}<\/p>\s*\) : \(\s*<PlanCta/);
  assert.doesNotMatch(view, /[—–]/);
});
