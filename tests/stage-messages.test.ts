import assert from 'node:assert/strict';
import test from 'node:test';
import { STAGE_MESSAGE_DRAFTS, isStageTemplateId, renderStageEmail } from '../lib/stages/messages';

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

test('drafts follow the writing rules: no long dashes, no Latin comma, no banned phrases', () => {
  for (const [key, draft] of Object.entries(STAGE_MESSAGE_DRAFTS)) {
    const text = [draft.subject, ...draft.paragraphs, draft.button?.label ?? '', ...((draft as { after?: string[] }).after ?? [])].join('\n');
    assert.ok(!/[—–]/.test(text), `${key}: long dash`);
    assert.ok(!text.includes(','), `${key}: Latin comma`);
    for (const phrase of BANNED) assert.ok(!text.includes(phrase), `${key}: banned phrase "${phrase}"`);
  }
});

test('rendering escapes a hostile name and falls back cleanly when the name is empty', () => {
  process.env.UNSUBSCRIBE_SECRET = 'test-secret-value';
  const hostile = renderStageEmail('registered_1h', { id: 'u1', email: 'a@b.co', name: '<script>alert(1)</script> x' });
  assert.ok(hostile && !hostile.html.includes('<script>'));
  const plain = renderStageEmail('registered_1h', { id: 'u1', email: 'a@b.co', name: null });
  assert.ok(plain);
  assert.ok(plain.html.includes('هلا،'));
  assert.ok(plain.footer?.includes('/api/messages/opt-out'));
  assert.equal(plain.headers?.['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.equal(isStageTemplateId('nope'), false);
});

test('a follow-up cannot be rendered without a way to opt out', () => {
  const saved = { u: process.env.UNSUBSCRIBE_SECRET, c: process.env.CRON_SECRET };
  delete process.env.UNSUBSCRIBE_SECRET;
  delete process.env.CRON_SECRET;
  try {
    assert.equal(renderStageEmail('registered_1h', { id: 'u1', email: 'a@b.co' }), null);
  } finally {
    if (saved.u) process.env.UNSUBSCRIBE_SECRET = saved.u;
    if (saved.c) process.env.CRON_SECRET = saved.c;
  }
});
