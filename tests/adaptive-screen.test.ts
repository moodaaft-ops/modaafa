import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { PlanCard } from '../lib/plan/plan-paywall';
import { buildPlan } from '../lib/plan/plan';
import { CONFIRM_OPTIONS } from '../lib/setup/adaptive/answers';
import type { AdaptiveOption, AdaptiveQuestion, AdaptiveView, ScenarioDecision } from '../lib/setup/adaptive/types';
import type { SetupState } from '../lib/setup/load';
import { AdaptiveDock, ConfirmDock } from '../app/onboarding/setup/adaptive-docks';
import {
  AgencyQuestionsCard,
  FirstCampaignCard,
  FullManagementCard,
  SeenBox,
  UnderstoodCard,
} from '../app/onboarding/setup/adaptive-cards';
import {
  EXCLUSIVE_OPTION_ID,
  SOURCE_TAG,
  agencyPlanSubtitle,
  auditPermitted,
  changesTree,
  chipsPayload,
  confirmPayload,
  freeTextPayload,
  optionPayload,
  replannedQueue,
  shouldStartAudit,
  toggleId,
} from '../app/onboarding/setup/adaptive-flow';

// The components are written for Next's automatic JSX runtime; tsx compiles them with the classic one.
(globalThis as unknown as { React: unknown }).React = React;

const html = (node: React.ReactElement) => renderToStaticMarkup(node);
const noop = () => undefined;

// ------------------------------------------------------------------ fixtures

function view(patch: Partial<AdaptiveView> = {}): AdaptiveView {
  return {
    scenario: { state: 'active', managed: 'unknown', kind: 'clinic', kindConfidence: 'high', platform: null, specialty: null, outcome: 'calls' },
    needsRead: false,
    opener: null,
    questions: {},
    understood: [],
    ending: 'plan',
    auditAllowed: true,
    decision: null,
    firstWhy: null,
    firstCampaign: null,
    agencyQuestions: [],
    fullManagementCard: false,
    ...patch,
  } as AdaptiveView;
}

function state(patch: { adaptive?: AdaptiveView | null; edit?: boolean; audit?: unknown; pending?: string[] } = {}): SetupState {
  return {
    adaptive: 'adaptive' in patch ? patch.adaptive : view(),
    edit: patch.edit ?? false,
    audit: patch.audit ?? null,
    pending: patch.pending ?? [],
  } as unknown as SetupState;
}

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

const lead: ScenarioDecision = {
  id: 'call_hours',
  title: 'وقّف الإعلان بعد التاسعة بالليل',
  reason: 'أغلب صرفك بالليل وما أحد يرد على الاتصال',
  why: 'قلت إن اللي يهمك الاتصالات',
  steps: ['افتح حملتك في قوقل', 'ادخل على جدولة الإعلانات', 'اطفِ الساعات الليلية'],
  amount: null,
  currency: 'SAR',
};

const opt = (id: string, label: string, extra: Partial<AdaptiveOption> = {}): AdaptiveOption => ({ id, label, ...extra });

// ------------------------------------------------------------------ the flow helpers

test('only the keys that change the tree ask for a re-plan', () => {
  for (const key of ['confirm', 'type', 'manager', 'has_account'] as const) assert.equal(changesTree(key), true, key);
  for (const key of ['name', 'goal', 'focus_service', 'aov_check', 'push_products', 'call_hours', 'consent'] as const) {
    assert.equal(changesTree(key), false, key);
  }
});

test('a re-plan outside edit mode takes the server list without the key just answered', () => {
  const queue = replannedQueue({ pending: ['confirm', 'focus_service', 'margin'], answeredNow: 'confirm', asked: ['confirm'], edit: false });
  assert.deepEqual(queue, ['focus_service', 'margin']);
});

test('a re-plan in edit mode also drops every key already asked in this run, and never repeats a key', () => {
  const queue = replannedQueue({
    pending: ['type', 'name', 'focus_service', 'name', 'margin'],
    answeredNow: 'type',
    asked: ['type', 'name'],
    edit: true,
  });
  assert.deepEqual(queue, ['focus_service', 'margin']);
});

test('the free audit starts only for the adaptive states that spend, outside edit, with none on record and the type and the opener settled', () => {
  assert.equal(shouldStartAudit(state()), true);
  assert.equal(shouldStartAudit(state({ adaptive: null })), false, 'legacy flow has its own rule');
  assert.equal(shouldStartAudit(state({ adaptive: view({ auditAllowed: false }) })), false, 'new, dormant and no account never spend');
  assert.equal(shouldStartAudit(state({ edit: true })), false);
  assert.equal(shouldStartAudit(state({ audit: { id: 'a' } })), false);
  assert.equal(shouldStartAudit(state({ pending: ['type'] })), false);
  assert.equal(shouldStartAudit(state({ pending: ['confirm', 'margin'] })), false);
  assert.equal(shouldStartAudit(state({ pending: ['margin'] })), true);
});

test('a retry is allowed on the legacy path and only where auditAllowed on the adaptive one', () => {
  assert.equal(auditPermitted(state({ adaptive: null })), true);
  assert.equal(auditPermitted(state({ adaptive: view({ auditAllowed: true }) })), true);
  assert.equal(auditPermitted(state({ adaptive: view({ auditAllowed: false }) })), false);
});

// ------------------------------------------------------------------ answer payloads

test('a tapped option sends its id and the label the customer read', () => {
  assert.deepEqual(optionPayload(opt('same', 'نفس الرقم')), { answer: { choice: 'same' }, label: 'نفس الرقم' });
});

test('«إي صح» carries the kind and outcome the opener proposed, «لا، غير كذا» carries nothing else', () => {
  const [yes, no] = CONFIRM_OPTIONS;
  const proposal = { kind: 'clinic', outcome: 'calls' } as const;
  assert.deepEqual(confirmPayload(yes, proposal).answer, { choice: 'yes', kind: 'clinic', outcome: 'calls' });
  assert.deepEqual(confirmPayload(no, proposal).answer, { choice: 'no' });
  assert.deepEqual(confirmPayload(yes, null).answer, { choice: 'yes' }, 'nothing proposed, nothing invented');
});

test('typing instead of tapping sends the shape each key accepts', () => {
  assert.deepEqual(freeTextPayload('focus_service', 'تقويم شفاف').answer, { choice: 'other', text: 'تقويم شفاف' });
  assert.deepEqual(freeTextPayload('push_products', 'عطر العود').answer, { choices: [], text: 'عطر العود' });
  assert.deepEqual(freeTextPayload('exclude_products', 'الكراتين').answer, { choice: 'text', text: 'الكراتين' });
  assert.equal(freeTextPayload('exclude_products', 'الكراتين').label, 'الكراتين');
});

test('ticked chips become one answer: the ids, the first as choice, the typed name, and one label', () => {
  const picked = [opt('p_0', 'عطر أ'), opt('p_2', 'عطر ج')];
  const payload = chipsPayload(picked, '  بخور  ');
  assert.deepEqual(payload.answer, { choice: 'p_0', choices: ['p_0', 'p_2'], text: 'بخور' });
  assert.equal(payload.label, 'عطر أ، عطر ج، بخور');
  assert.deepEqual(chipsPayload([], 'بخور').answer, { choices: [], text: 'بخور' });
  assert.deepEqual(chipsPayload(picked, '').answer, { choice: 'p_0', choices: ['p_0', 'p_2'] });
});

test('toggling a chip adds it, toggling again removes it, and the exclusive option has its own id', () => {
  assert.deepEqual(toggleId([], 'a'), ['a']);
  assert.deepEqual(toggleId(['a', 'b'], 'a'), ['b']);
  assert.equal(EXCLUSIVE_OPTION_ID, 'none');
});

test('the source tags are the words of the approved snapshot', () => {
  assert.deepEqual(SOURCE_TAG, { account: 'من حسابك', confirmed: 'أكدته', you: 'قلته' });
});

test('an agency account with exactly one visible decision gets a sentence without «التنفيذ»', () => {
  const one = buildPlan({ audit, currency: 'SAR', recommendations: [rec('a')] });
  const text = agencyPlanSubtitle(one, false, true);
  assert.ok(text && text.includes('تجربتك المجانية') && !text.includes('التنفيذ'));
  assert.ok(agencyPlanSubtitle(one, false, false)?.includes('اشتراكك'));
  // The rules decision counts as one more beside the locked ones.
  const led = { ...one, locked: [] };
  assert.ok(agencyPlanSubtitle(led, true, true));
  const many = buildPlan({ audit, currency: 'SAR', recommendations: [rec('a'), rec('b'), rec('c')] });
  assert.equal(agencyPlanSubtitle(many, false, true), null, 'more than one decision keeps the card sentence');
  assert.equal(agencyPlanSubtitle({ ...many, locked: many.locked.slice(0, 1) }, true, true), null);
});

// ------------------------------------------------------------------ PlanCard

test('PlanCard without the adaptive props shows none of the adaptive blocks', () => {
  const plan = buildPlan({ audit, currency: 'SAR', recommendations: [rec('a', { severity: 'critical' }), rec('b'), rec('c')] });
  const out = html(React.createElement(PlanCard, { plan, trialEligible: true, id: 'plan-card' }));
  assert.ok(out.includes('خطتك جاهزة') && out.includes('قرار a') && out.includes('سبب a'));
  assert.ok(!out.includes('ليش أول شي') && !out.includes('كيف أسويه'));
  // Null props are the same as no props.
  const nulls = html(React.createElement(PlanCard, { plan, trialEligible: true, id: 'plan-card', lead: null, firstWhy: null, subtitle: null }));
  assert.equal(nulls, out);
});

test('PlanCard with a lead opens it in place of the audit decision: reason, why, closed manual steps, no «اعتمد»', () => {
  const base = buildPlan({ audit, currency: 'SAR', recommendations: [rec('a', { severity: 'critical' }), rec('b')] });
  // What the server sends: the audit's first decision moved into the locked list.
  const plan = { ...base, first: null, locked: [{ id: 'a', title: 'قرار a', severity: 'critical' }, ...base.locked] };
  const out = html(React.createElement(PlanCard, { plan, trialEligible: true, lead }));
  assert.ok(out.includes(lead.title) && out.includes(lead.reason) && out.includes(lead.why));
  assert.ok(out.includes('ليش أول شي') && out.includes('كيف أسويه؟'));
  for (const step of lead.steps) assert.ok(out.includes(step), step);
  assert.ok(!/<details[^>]* open/.test(out), 'the steps start closed');
  assert.ok(!out.includes('اعتمد'), 'the steps are manual');
  assert.ok(out.includes('قرار a') && out.includes('قرار b'), 'the audit decisions stay as locked rows');
  assert.ok(out.includes('خطتك جاهزة'));
  assert.ok(out.includes('3 قرارات'), 'the lead counts beside the two locked ones');
});

test('PlanCard shows «ليش أول شي» under the audit decision when there is no lead', () => {
  const plan = buildPlan({ audit, currency: 'SAR', recommendations: [rec('a'), rec('b')] });
  const out = html(React.createElement(PlanCard, { plan, trialEligible: true, firstWhy: 'لأنك قلت إن الهدر يضايقك' }));
  assert.ok(out.includes('ليش أول شي') && out.includes('لأنك قلت إن الهدر يضايقك'));
  assert.ok(out.indexOf('سبب a') < out.indexOf('لأنك قلت'), 'the line comes after the decision it explains');
});

test('PlanCard takes the subtitle it is given in place of its own sentence', () => {
  const plan = buildPlan({ audit, currency: 'SAR', recommendations: [rec('a')] });
  const out = html(React.createElement(PlanCard, { plan, trialEligible: true, subtitle: 'جملة من عندي' }));
  assert.ok(out.includes('جملة من عندي'));
});

// ------------------------------------------------------------------ the cards

test('the cards show what the tree gave them', () => {
  assert.ok(html(React.createElement(SeenBox, { rows: ['٣ حملات شغالة', 'الصرف أغلبه بجدة'] })).includes('اللي شفته'));

  const understood = html(
    React.createElement(UnderstoodCard, {
      rows: [
        { label: 'نشاطك', value: 'عيادة أسنان', source: 'confirmed' },
        { label: 'اللي يهمك', value: 'الاتصالات', source: 'you' },
        { label: 'الميزانية', value: 'من حسابك', source: 'account' },
      ],
    })
  );
  for (const word of ['فهمت عليك', 'عيادة أسنان', 'أكدته', 'قلته', 'من حسابك']) assert.ok(understood.includes(word), word);

  const campaign = html(
    React.createElement(FirstCampaignCard, {
      plan: {
        title: 'خطة أول حملة',
        campaign: 'حملة بحث على التقويم في جدة',
        budgetLine: 'ميزانية تبدأ فيها',
        items: [{ label: 'الكلمات', detail: 'تقويم الأسنان في جدة' }],
        next: 'trial',
      },
    })
  );
  assert.ok(campaign.includes('id="plan-card"') && campaign.includes('تقويم الأسنان في جدة'));
  // The budget is one of the items (with the daily figure); no second pill repeating it.
  assert.ok(!campaign.includes('الميزانية:'));

  const agency = html(React.createElement(AgencyQuestionsCard, { questions: ['ليش الصرف بالليل؟', 'وين يروح الاتصال؟'] }));
  assert.ok(agency.includes('أسئلة تسألها وكالتك') && agency.includes('ليش الصرف بالليل؟') && agency.includes('وين يروح الاتصال؟'));

  const full = html(React.createElement(FullManagementCard, { email: 'a@b.com' }));
  assert.ok(full.includes('خل فريق مُضاعفة يديرها عنك') && full.includes('https://wa.me/966541004029') && full.includes('target="_blank"'));
});

// ------------------------------------------------------------------ the docks

test('the opener dock has the two confirm tiles, «إي صح» first', () => {
  const out = html(React.createElement(ConfirmDock, { proposal: null, busy: false, onAnswer: noop }));
  assert.ok(out.indexOf('إي صح') > -1 && out.indexOf('إي صح') < out.indexOf('لا، غير كذا'));
});

function question(patch: Partial<AdaptiveQuestion>): AdaptiveQuestion {
  return { key: 'aov_check', text: 'سؤال', options: [], layout: 'tiles', freeText: null, current: null, ...patch };
}
const dock = (q: AdaptiveQuestion, canBack = false) =>
  html(React.createElement(AdaptiveDock, { question: q, busy: false, canBack, onBack: noop, onAnswer: noop }));

test('tiles go one per row, tiles2 in two columns, and the current answer is marked in edit mode', () => {
  const options = [opt('same', 'نفس الرقم'), opt('other', 'غير كذا')];
  assert.ok(dock(question({ options, layout: 'tiles' })).includes('grid-cols-1'));
  assert.ok(dock(question({ options, layout: 'tiles2' })).includes('grid-cols-2'));
  const marked = dock(question({ options, current: 'same' }));
  assert.ok(marked.includes('الحالي'));
  assert.ok(!dock(question({ options })).includes('الحالي'));
});

test('a free-text field replaces the «غير كذا» tile and keeps its placeholder and limit', () => {
  const q = question({
    key: 'focus_service',
    options: [opt('braces', 'تقويم'), opt('other', 'غير كذا')],
    freeText: { placeholder: 'اكتب خدمتك', maxLength: 40 },
  });
  const out = dock(q);
  assert.ok(out.includes('تقويم') && !out.includes('غير كذا'));
  assert.ok(out.includes('اكتب خدمتك') && out.includes('maxLength="40"'));
});

test('a question with no options shows only its field', () => {
  const out = dock(question({ key: 'exclude_products', options: [], freeText: { placeholder: 'اكتب اسم المنتج', maxLength: 80 } }));
  assert.ok(out.includes('اكتب اسم المنتج'));
  assert.ok(!out.includes('aria-pressed'));
});

test('chips are toggles with a «تم» button that waits for a choice, and the exclusive option sits apart', () => {
  const out = dock(
    question({
      key: 'push_products',
      layout: 'chips',
      options: [opt('p_0', 'عطر أ'), opt('p_1', 'عطر ب'), opt(EXCLUSIVE_OPTION_ID, 'لا، كلها سوا')],
      freeText: { placeholder: 'أو اكتب اسمه', maxLength: 80 },
    })
  );
  assert.equal((out.match(/aria-pressed="false"/g) ?? []).length, 2, 'two chips, the exclusive one is not a chip');
  assert.ok(/<button[^>]*disabled[^>]*type="submit"|<button[^>]*type="submit"[^>]*disabled/.test(out), '«تم» starts disabled');
  assert.ok(out.includes('لا، كلها سوا') && out.includes('أو اكتب اسمه'));
});

test('the back link shows only when there is something to go back to', () => {
  const q = question({ options: [opt('same', 'نفس الرقم')] });
  assert.ok(dock(q, true).includes('رجوع'));
  assert.ok(!dock(q, false).includes('رجوع'));
});

// ------------------------------------------------------------------ copy rules on the new files

const FILES = [
  'app/onboarding/setup/adaptive-cards.tsx',
  'app/onboarding/setup/adaptive-docks.tsx',
  'app/onboarding/setup/adaptive-flow.ts',
  'app/onboarding/setup/setup-chat.tsx',
  'lib/plan/plan-paywall.tsx',
];

test('the new screen files follow the copy rules: no long dashes, no banned phrases, no wrong name, no Inter', () => {
  const banned = ['ليس مجرد', 'بالإضافة إلى ذلك', 'علاوة على ذلك', 'من الجدير بالذكر', 'حلول متكاملة', 'رحلتك', 'باختصار'];
  for (const file of FILES) {
    const source = readFileSync(resolve(__dirname, '..', file), 'utf8');
    assert.ok(!source.includes('—') && !source.includes('–'), `${file} has an em or en dash`);
    for (const phrase of banned) assert.ok(!source.includes(phrase), `${file} has «${phrase}»`);
    assert.ok(!source.includes('زياد'), `${file} names the wrong assistant`);
    assert.ok(!/\bInter\b/.test(source), `${file} mentions Inter`);
    assert.ok(!/unverified|غير موثق|غير معتمد من قوقل/i.test(source), `${file} speaks of an unverified app`);
  }
});
