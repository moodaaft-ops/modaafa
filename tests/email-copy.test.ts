import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EMAIL_COPY, buildAll, decisions, days } from '../lib/lifecycle/copy';
import { COPY_KEYS, EMPTY_FACTS, type EmailFacts } from '../lib/lifecycle/types';

const RICH: EmailFacts = {
  firstName: 'سارة',
  businessName: 'مشغل سارة',
  plan: { decisionsTotal: 6, lockedCount: 5, firstDecisionTitle: 'وقّف حملة الرياض العامة', wasteEstimate: 1240.4, currency: 'SAR' },
  trial: { startedAt: '2026-10-10T09:00:00Z', endsAt: '2026-10-24T09:00:00Z', daysLeft: 9, approvedCount: 3, pendingCount: 2 },
  weekly: {
    periodStart: '2026-10-04T00:00:00Z',
    periodEnd: '2026-10-10T00:00:00Z',
    currency: 'SAR',
    spend: 2310,
    conversions: 47,
    costPerConversion: 49.15,
    prevSpend: 2500,
    prevConversions: 39,
    highlights: ['حملة الرياض — أعلى تكلفة', 'الكلمات العامة صرفت بدون تحويل'],
    pendingCount: 1,
  },
  billing: { planName: 'النمو', trialEndsAt: '2026-10-24T09:00:00Z' },
};

const ZERO_TRIAL: EmailFacts = {
  ...RICH,
  trial: { ...RICH.trial!, approvedCount: 0, pendingCount: 0, daysLeft: null },
};

function allText(facts: EmailFacts): string[] {
  const out: string[] = [];
  for (const { email } of buildAll(facts)) {
    if (!email) continue;
    out.push(email.subject, email.preheader, email.ps ?? '', email.cta?.label ?? '');
    for (const block of email.blocks) {
      if (block.type === 'list') out.push(...block.items);
      else if (block.type === 'stat') out.push(block.label, block.value, block.note ?? '');
      else out.push(block.text);
    }
  }
  return out;
}

test('every copy key has exactly one entry with a matching key', () => {
  assert.deepEqual(Object.keys(EMAIL_COPY).sort(), [...COPY_KEYS].sort());
  for (const key of COPY_KEYS) assert.equal(EMAIL_COPY[key].key, key);
});

test('only the live billing mails are approved; everything else waits for Ayman', () => {
  for (const key of COPY_KEYS) {
    const approved = EMAIL_COPY[key].approved;
    assert.equal(approved, key.startsWith('tx_'), key);
  }
});

test('house style: no em or en dash, no Latin comma, no stock AI phrases, in any variant', () => {
  const banned = ['ليس مجرد', 'لا تفوت', 'المستوى التالي', 'بالإضافة إلى ذلك', 'علاوة على ذلك', 'من الجدير بالذكر', 'رحلتك', 'حلول متكاملة', 'هل تعاني', 'في النهاية', 'باختصار'];
  for (const facts of [RICH, ZERO_TRIAL, EMPTY_FACTS]) {
    for (const line of allText(facts)) {
      assert.doesNotMatch(line, /[—–]/, line);
      // A comma between digits is a thousands separator (1,240), not punctuation.
      const punctuation = line.replace(/(\d),(\d)/g, '$1$2');
      assert.doesNotMatch(punctuation, /[؀-ۿ][^\n]*,|,[^\n]*[؀-ۿ]/, line);
      for (const phrase of banned) assert.ok(!line.includes(phrase), `${phrase} in: ${line}`);
    }
  }
});

test('subjects and preheaders stay short enough for a phone inbox', () => {
  for (const facts of [RICH, ZERO_TRIAL, EMPTY_FACTS]) {
    for (const { key, email } of buildAll(facts)) {
      if (!email) continue;
      assert.ok(email.subject.length <= 70, `${key} subject ${email.subject.length}`);
      assert.ok(email.preheader.length <= 90, `${key} preheader`);
      if (email.cta) assert.ok(email.cta.path.startsWith('/') && !email.cta.path.startsWith('//'), key);
    }
  }
});

test('copies that need facts return null without them instead of guessing', () => {
  for (const key of ['plan_ready_1d', 'trial_d1', 'trial_d4', 'trial_d9', 'weekly_report'] as const) {
    assert.equal(EMAIL_COPY[key].build(EMPTY_FACTS), null, key);
  }
  assert.equal(EMAIL_COPY.plan_ready_1d.build({ ...RICH, plan: { ...RICH.plan!, decisionsTotal: 0 } }), null);
});

test('numbers come from the facts, in Latin digits', () => {
  const plan = EMAIL_COPY.plan_ready_1d.build(RICH)!;
  assert.match(plan.subject, /1,240/);
  assert.ok(plan.blocks.some((b) => b.type === 'p' && b.text.includes('5 قرارات')));
  const noWaste = EMAIL_COPY.plan_ready_1d.build({ ...RICH, plan: { ...RICH.plan!, wasteEstimate: null } })!;
  assert.ok(!noWaste.blocks.some((b) => b.type === 'stat'));
  assert.doesNotMatch(noWaste.subject, /[0-9]/);

  const weekly = EMAIL_COPY.weekly_report.build(RICH)!;
  assert.match(weekly.subject, /47 تحويل/);
  const list = weekly.blocks.find((b) => b.type === 'list');
  assert.ok(list && list.type === 'list' && list.items[0] === 'حملة الرياض، أعلى تكلفة');
});

test('trial copy changes with what the person actually did', () => {
  assert.match(EMAIL_COPY.trial_d1.build(RICH)!.subject, /اعتمدت أول قرار/);
  assert.match(EMAIL_COPY.trial_d1.build(ZERO_TRIAL)!.subject, /ينتظرك/);
  assert.equal(EMAIL_COPY.trial_d9.build(ZERO_TRIAL)!.cta?.label, 'جرّب قرار واحد');
});

test('counting words follow Saudi usage', () => {
  assert.equal(decisions(1), 'قرار واحد');
  assert.equal(decisions(2), 'قرارين');
  assert.equal(decisions(7), '7 قرارات');
  assert.equal(decisions(14), '14 قرار');
  assert.equal(days(10), '10 أيام');
  assert.equal(days(11), '11 يوم');
});
