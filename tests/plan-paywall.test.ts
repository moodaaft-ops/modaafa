import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { TRIAL_DAYS } from '../lib/billing/checkout-policy';
import { toPlanRecommendations } from '../lib/plan/load';
import {
  PLAN_COPY,
  PLAN_TRIAL_DAYS_IN_COPY,
  buildPlan,
  cancelLine,
  ctaLabel,
  lockedBarLine,
  planSubtitle,
  planTitle,
  sheetLine,
  type PlanKind,
  type PlanSheetReason,
} from '../lib/plan/plan';

const rec = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `قرار ${id}`,
  description: `سبب ${id}`,
  severity: 'medium',
  status: 'pending',
  created_at: '2026-10-13T08:00:00.000Z',
  expected_impact: null,
  executable: true,
  ...extra,
});

const audit = { health_score: 58, estimated_monthly_waste: 1840, ran_at: '2026-10-13T07:00:00.000Z' };

// ------------------------------------------------------------------ the plan

test('a plan with decisions opens the first one in full and lists the rest as locked rows', () => {
  const plan = buildPlan({
    audit,
    currency: 'sar',
    recommendations: [
      rec('b', { severity: 'growth', created_at: '2026-10-13T09:00:00.000Z' }),
      rec('a', { severity: 'critical', expected_impact: { metric: 'cost', delta_sar_per_month: 412 } }),
      rec('c', { severity: 'medium' }),
    ],
  });
  assert.equal(plan.kind, 'ready');
  assert.equal(plan.currency, 'SAR');
  assert.equal(plan.healthScore, 58);
  assert.equal(plan.healthWord, 'يحتاج شغل');
  assert.equal(plan.waste, 1840);
  assert.equal(plan.decisionsCount, 3);
  assert.equal(plan.first?.id, 'a', 'critical first');
  assert.equal(plan.first?.reason, 'سبب a');
  assert.equal(plan.first?.impactLabel, 'توفير متوقع شهرياً');
  assert.equal(plan.first?.impactAmount, 412);
  assert.equal(plan.first?.executable, true);
  assert.deepEqual(plan.locked.map((row) => row.id), ['c', 'b']);
});

test('a locked decision carries nothing but id, title and severity: no reason, amount or payload reaches the browser', () => {
  const plan = buildPlan({
    audit,
    recommendations: [
      rec('open', { severity: 'critical' }),
      rec('hidden', {
        description: 'سبب سري لا يظهر قبل التجربة',
        expected_impact: { metric: 'cost', delta_sar_per_month: 999 },
        action_payload: { operation: 'pause_campaign', target_id: 'customers/1/campaigns/2' },
      }),
    ],
  });
  assert.deepEqual(Object.keys(plan.locked[0]).sort(), ['id', 'severity', 'title']);
  const wire = JSON.stringify(plan.locked);
  assert.ok(!wire.includes('سبب سري') && !wire.includes('999') && !wire.includes('pause_campaign'));
});

test('the estimated waste is shown only when the audit produced a positive number', () => {
  for (const waste of [0, null, undefined, '', 'abc', -5]) {
    const plan = buildPlan({ audit: { ...audit, estimated_monthly_waste: waste as any }, recommendations: [rec('a')] });
    assert.equal(plan.waste, null, String(waste));
  }
  assert.equal(buildPlan({ audit: { ...audit, estimated_monthly_waste: '1234.5' }, recommendations: [rec('a')] }).waste, 1234.5);
});

test('no audit on record is an honest plan with no score, no waste and no invented decisions', () => {
  const plan = buildPlan({ audit: null, recommendations: [] });
  assert.equal(plan.kind, 'no_audit');
  assert.equal(plan.healthScore, null);
  assert.equal(plan.healthWord, null);
  assert.equal(plan.waste, null);
  assert.equal(plan.first, null);
  assert.deepEqual(plan.locked, []);
  assert.equal(plan.decisionsCount, 0);
});

test('an audit with nothing to decide says so instead of showing a zero', () => {
  const plan = buildPlan({ audit: { health_score: 91, estimated_monthly_waste: 0 }, recommendations: [] });
  assert.equal(plan.kind, 'no_decisions');
  assert.equal(plan.healthScore, 91);
  assert.equal(plan.waste, null);
  assert.equal(plan.first, null);
});

test('rows without an id or a title, and repeats, are dropped; an approved change goes first', () => {
  const plan = buildPlan({
    audit,
    recommendations: [
      rec('x', { title: '   ' }),
      { ...rec('y'), id: '' },
      rec('p', { severity: 'critical' }),
      rec('p', { severity: 'critical' }),
      rec('ap', { status: 'approved', severity: 'growth' }),
    ],
  });
  assert.equal(plan.decisionsCount, 2);
  assert.equal(plan.first?.id, 'ap');
  assert.deepEqual(plan.locked.map((row) => row.id), ['p']);
});

test('a single decision has nothing locked, a missing reason stays null, and executable defaults to false', () => {
  const plan = buildPlan({ audit, recommendations: [rec('only', { description: null, executable: undefined })] });
  assert.equal(plan.locked.length, 0);
  assert.equal(plan.first?.reason, null);
  assert.equal(plan.first?.executable, false);
});

test('stored recommendation rows map to plan input, with executable decided from the payload', () => {
  const rows = toPlanRecommendations([
    {
      id: 'r1',
      title: 'أوقف عبارة',
      description: 'سبب',
      severity: 'critical',
      status: 'pending',
      expected_impact: null,
      created_at: null,
      action_payload: { operation: 'review_ads' },
    },
  ]);
  assert.equal(rows[0].id, 'r1');
  assert.equal(rows[0].executable, false, 'a review-only operation is not applied by «اعتمد»');
  assert.deepEqual(toPlanRecommendations(null), []);
});

// ------------------------------------------------------------------ the words

const ALL_COPY = () => {
  const kinds: PlanKind[] = ['ready', 'no_decisions', 'no_audit'];
  const reasons: PlanSheetReason[] = ['chat', 'voice', 'approve', 'default'];
  const out: string[] = Object.values(PLAN_COPY);
  for (const trial of [true, false]) {
    out.push(ctaLabel(trial), cancelLine(trial), lockedBarLine(trial));
    for (const kind of kinds) {
      out.push(planTitle(kind));
      for (const decisionsCount of [0, 1, 2, 3, 11]) out.push(planSubtitle({ kind, decisionsCount }, trial));
    }
    for (const reason of reasons) out.push(sheetLine(reason, trial));
  }
  return out;
};

test('the copy is the owner copy: title, CTA, the cancel promise, the trust line and the locked bar', () => {
  assert.equal(PLAN_COPY.title, 'خطتك جاهزة');
  assert.equal(ctaLabel(true), 'ابدأ 14 يوم مجاناً');
  assert.equal(cancelLine(true), 'تلغي بضغطة من داخل التطبيق قبل ما تنتهي');
  assert.equal(PLAN_COPY.trust, 'ولا شي يتغير في حسابك إلا باعتمادك، وتقدر ترجّع أي تعديل خلال 30 يوم.');
  assert.equal(lockedBarLine(true), 'المحادثة مع مُضاعِف تنفتح مع تجربتك المجانية');
  assert.equal(PLAN_COPY.later, 'أشوف الخطة بعدين');
  assert.equal(
    planSubtitle({ kind: 'ready', decisionsCount: 3 }, true),
    'فحصت حسابك وطلعت لك 3 قرارات. أول واحد قدامك، والباقي ينفتح مع تجربتك المجانية.'
  );
});

test('the copy has no em or en dash and no Latin comma between Arabic words', () => {
  for (const text of ALL_COPY()) {
    assert.doesNotMatch(text, /[–—]/, text);
    assert.doesNotMatch(text, /[؀-ۿ]\s*,\s*[؀-ۿ]/, text);
  }
});

test('the trial length in the copy is the real trial length', () => {
  assert.equal(PLAN_TRIAL_DAYS_IN_COPY, TRIAL_DAYS);
  assert.ok(PLAN_COPY.ctaTrial.includes(String(TRIAL_DAYS)));
});

test('someone who cannot get a trial is never promised free days', () => {
  for (const kind of ['ready', 'no_decisions', 'no_audit'] as PlanKind[]) {
    for (const decisionsCount of [0, 1, 4]) {
      assert.doesNotMatch(planSubtitle({ kind, decisionsCount }, false), /مجان|14/);
    }
  }
  for (const reason of ['chat', 'voice', 'approve', 'default'] as PlanSheetReason[]) {
    assert.doesNotMatch(sheetLine(reason, false), /مجان|14/);
  }
  assert.doesNotMatch(ctaLabel(false) + cancelLine(false) + lockedBarLine(false), /مجان|14/);
});

// ------------------------------------------------------------------ where it is used

const read = (path: string) => readFileSync(path, 'utf8');

test('the paywall components make no request at all: the CTA is a plain link to the existing checkout entry', () => {
  const view = read('lib/plan/plan-paywall.tsx');
  assert.ok(!/\bfetch\s*\(/.test(view) && !view.includes('XMLHttpRequest') && !view.includes('/api/'));
  // The default CTA is the checkout entry (paywallCta); a stopped subscription points to /billing instead.
  assert.ok(view.includes('paywallCta') && view.includes('target.href'));
  assert.match(read('lib/plan/plan.ts').toString(), /href: PLAN_CHECKOUT_PATH/);
  assert.equal(read('lib/plan/plan.ts').match(/PLAN_CHECKOUT_PATH = '([^']+)'/)?.[1], '/onboarding/trial');
});

test('locked /home mounts no chat client and names no chat or voice route', () => {
  const locked = read('app/(dashboard)/home/locked-home.tsx');
  assert.ok(!locked.includes('StartClient') && !locked.includes('HomeThread') && !locked.includes('VoiceCallPanel'));
  assert.ok(!locked.includes('/api/chat') && !locked.includes('/api/voice') && !/\bfetch\s*\(/.test(locked));
});

test('/home picks the locked plan from the shared access predicate, before the conversation is built', () => {
  const page = read('app/(dashboard)/home/page.tsx');
  const gate = page.indexOf('if (!hasProductAccess(access))');
  assert.ok(gate > -1);
  assert.ok(page.indexOf('<LockedHome') > gate && page.indexOf('<LockedHome') < page.indexOf('<HomeThread'));
  assert.ok(page.indexOf('<HomeThread') > gate, 'the conversation renders only after the gate');
});

test('onboarding ends on the plan for someone without access and keeps its old ending for someone with it', () => {
  const chat = read('app/onboarding/setup/setup-chat.tsx');
  const branch = chat.indexOf('if (!s.subscriptionActive && s.plan)');
  assert.ok(branch > -1);
  assert.ok(chat.indexOf("kind: 'plan'", branch) > branch);
  assert.ok(chat.includes('PLAN_COPY.later') && chat.includes('PLAN_LATER_PATH'));
  assert.equal(read('lib/plan/plan.ts').match(/PLAN_LATER_PATH = '([^']+)'/)?.[1], '/home');
  // The paywall replaces the result bubbles: it is decided before «خلصت الفحص. صحة حسابك …» is said.
  assert.ok(branch < chat.indexOf('خلصت الفحص. صحة حسابك'));
  // Someone with access still gets «يلا ندخل صفحتك».
  assert.ok(chat.includes('يلا ندخل صفحتك'));
});
