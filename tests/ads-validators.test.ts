import assert from 'node:assert/strict';
import test from 'node:test';

import {
  adTextLength,
  buildGrounding,
  extractNumbers,
  findDuplicateMeaning,
  pinsAreSane,
  pinsStayTheSame,
  sameMeaning,
  validateAssetText,
  validateCandidateSet,
  validateRsaStructure,
} from '../lib/ads/validators';

const ar = (sources: string[] = ['صالون الورد في الرياض']) => ({ language: 'ar' as const, grounding: buildGrounding(sources) });
const en = (sources: string[] = ['Rose Salon in Riyadh']) => ({ language: 'en' as const, grounding: buildGrounding(sources) });
const code = (r: any) => (r.ok ? 'ok' : r.code);

test('length: Arabic is counted by characters and the 30/90 limits hold', () => {
  assert.equal(adTextLength('صالون'), 5);
  assert.equal(adTextLength('صَالُون'), adTextLength('صَالُون'));
  const ok = 'احجزي موعدك في صالون الورد';
  assert.equal(validateAssetText(ok, 'headline', ar()).ok, true);
  assert.equal(code(validateAssetText('ا'.repeat(31), 'headline', ar())), 'too_long');
  assert.equal(code(validateAssetText('ب'.repeat(91), 'description', ar())), 'too_long');
  assert.equal(code(validateAssetText('ص', 'headline', ar())), 'too_short');
});

test('banned patterns are rejected', () => {
  const cases: Array<[string, string]> = [
    ['صالون الورد — الرياض', 'dash'],
    ['صالون الورد – الرياض', 'dash'],
    ['اتصلي 0555123456 الآن', 'phone_number'],
    ['احجزي الآن!', 'exclamation'],
    ['صالون الورد, الرياض', 'latin_punctuation_in_arabic'],
    ['www.rose.sa صالون الورد', 'url_or_handle'],
  ];
  for (const [text, expected] of cases) {
    assert.equal(code(validateAssetText(text, 'headline', ar())), expected, text);
  }
});

test('invented numbers and unverifiable claims are rejected, grounded ones pass', () => {
  assert.equal(code(validateAssetText('خصم 40 بالمية على الخدمات', 'headline', ar())), 'invented_number');
  assert.equal(validateAssetText('خصم 40 بالمية', 'headline', ar(['خصم 40 بالمية'])).ok, true);
  assert.equal(code(validateAssetText('أفضل صالون في الرياض', 'headline', ar())), 'unverifiable_claim');
  assert.equal(code(validateAssetText('The best salon in Riyadh', 'headline', en())), 'unverifiable_claim');
  assert.deepEqual(extractNumbers('٤٠ و 15'), ['40', '15']);
});

test('AI phrases and wrong language are rejected', () => {
  assert.equal(code(validateAssetText('لا تفوت الفرصة اليوم', 'headline', ar())), 'ai_phrase');
  assert.equal(validateAssetText('Book your visit today', 'headline', ar()).ok, false);
});

test('duplicate meaning is detected', () => {
  assert.equal(sameMeaning('احجزي موعدك في صالون الورد', 'احجزي موعدك في صالون الورد'), true);
  assert.equal(sameMeaning('صبغة شعر', 'قص الاظافر'), false);
  assert.deepEqual(findDuplicateMeaning(['احجزي موعدك اليوم', 'احجزي موعدك اليوم', 'قص وتصفيف']), [1]);
});

test('pins stay the same and stay sane', () => {
  const before = [{ text: 'أ', pinned_field: 'HEADLINE_1' as const }, { text: 'ب' }];
  assert.equal(pinsStayTheSame(before, [{ text: 'ج', pinned_field: 'HEADLINE_1' }, { text: 'د' }]), true);
  assert.equal(pinsStayTheSame(before, [{ text: 'أ' }, { text: 'ب' }]), false);
  assert.equal(pinsStayTheSame(before, [{ text: 'أ', pinned_field: 'HEADLINE_2' }, { text: 'ب' }]), false);
  assert.equal(pinsAreSane([{ text: 'أ', pinned_field: 'DESCRIPTION_1' }], []), false);
  assert.equal(pinsAreSane([{ text: 'أ', pinned_field: 'HEADLINE_1' }], [{ text: 'ب', pinned_field: 'DESCRIPTION_1' }]), true);
});

test('RSA structure needs 3-15 headlines and 2-4 descriptions', () => {
  const h = (n: number) => Array.from({ length: n }, (_, i) => ({ text: `عنوان ${i}` }));
  const d = (n: number) => Array.from({ length: n }, (_, i) => ({ text: `وصف ${i}` }));
  assert.equal(validateRsaStructure(h(3), d(2)).ok, true);
  assert.equal(validateRsaStructure(h(2), d(2)).ok, false);
  assert.equal(validateRsaStructure(h(16), d(2)).ok, false);
  assert.equal(validateRsaStructure(h(5), d(1)).ok, false);
  assert.equal(validateRsaStructure(h(5), d(5)).ok, false);
});

test('candidate set drops invalid and duplicate texts and never passes a failed one', () => {
  const report = validateCandidateSet(
    ['احجزي موعدك في صالون الورد', 'احجزي موعدك في صالون الورد', 'أفضل صالون', 'عناية بالشعر والبشرة', 'تواصلي معنا 0555123456'],
    'headline',
    ar(),
    ['قص وتصفيف']
  );
  assert.deepEqual(report.accepted, ['احجزي موعدك في صالون الورد', 'عناية بالشعر والبشرة']);
  assert.ok(report.rejected.length >= 3);
});
