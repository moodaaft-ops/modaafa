import assert from 'node:assert/strict';
import test from 'node:test';
import { STAGE_FOLLOWUP_STEPS } from '../config/stage-followups';
import { STAGE_MESSAGE_DRAFTS, renderStageMessage } from '../lib/stages/messages';

const BANNED = [
  'ليس مجرد',
  'لا يتعلق الأمر',
  'يُعتبر من أبرز',
  'بالإضافة إلى ذلك',
  'علاوة على ذلك',
  'من الجدير بالذكر',
  'في عالم اليوم',
  'في ظل التطور',
  'رحلتك نحو',
  'خذها للمستوى التالي',
  'لا تفوت الفرصة',
  'حلول متكاملة',
  'مصمم خصيصاً',
  'هل تعاني من',
  'جودة عالية',
];

test('every configured step has a draft text, and no draft is orphaned', () => {
  const keys = Object.values(STAGE_FOLLOWUP_STEPS).flatMap((list) => (list ?? []).map((step) => step.key));
  assert.deepEqual([...keys].sort(), Object.keys(STAGE_MESSAGE_DRAFTS).sort());
});

test('no step is approved by default: texts wait for Ayman', () => {
  for (const list of Object.values(STAGE_FOLLOWUP_STEPS)) {
    for (const step of list ?? []) assert.equal(step.approved, false, step.key);
  }
});

test('drafts follow the writing rules: no long dashes, no Latin comma, no banned phrases', () => {
  for (const [key, draft] of Object.entries(STAGE_MESSAGE_DRAFTS)) {
    const text = [draft.subject, ...draft.paragraphs, draft.button?.label ?? '', ...(draft.after ?? [])].join('\n');
    assert.ok(!/[—–]/.test(text), `${key}: long dash`);
    assert.ok(!text.includes(','), `${key}: Latin comma`);
    for (const phrase of BANNED) assert.ok(!text.includes(phrase), `${key}: banned phrase "${phrase}"`);
  }
});

test('rendering escapes a hostile name and falls back cleanly when the name is empty', () => {
  const hostile = renderStageMessage('registered_1h', { name: '<script>alert(1)</script> x', unsubscribeUrl: 'https://x' });
  assert.ok(hostile && !hostile.html.includes('<script>'));
  const plain = renderStageMessage('registered_1h', { name: null, unsubscribeUrl: 'https://x' });
  assert.ok(plain);
  assert.ok(plain.html.includes('هلا،'));
  assert.equal(renderStageMessage('nope', { unsubscribeUrl: 'https://x' }), null);
});
