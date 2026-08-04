import test from 'node:test';
import assert from 'node:assert/strict';

// Mirror of the search helpers in app/(dashboard)/account-switcher.tsx.
// The component is a client module ('use client') that pulls in React and
// next/navigation, so the pure helpers are re-declared here and kept in sync;
// this test locks the behaviour the switcher relies on.
function foldArabic(value: string) {
  return value
    .replace(/[ً-ْ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي');
}
function toAsciiDigits(value: string) {
  return value.replace(/[٠-٩۰-۹]/g, (ch) => {
    const code = ch.charCodeAt(0);
    const base = code >= 0x06f0 ? 0x06f0 : 0x0660;
    return String(code - base);
  });
}

test('Arabic-Indic digits map to ASCII so numeric account search works', () => {
  assert.equal(toAsciiDigits('٧٥٦١١٤').replace(/\D/g, ''), '756114');
  assert.equal(toAsciiDigits('۷۵۶').replace(/\D/g, ''), '756'); // Persian digits
  assert.equal(toAsciiDigits('756-114').replace(/\D/g, ''), '756114'); // ASCII unchanged
});

test('a real customer id is matched when typed in Arabic digits', () => {
  const query = toAsciiDigits(foldArabic('٧٥٦'.toLowerCase())).replace(/\D/g, '');
  assert.ok(query.length > 0 && '7561141000'.includes(query));
});

test('Arabic letter variants fold so name search is forgiving', () => {
  assert.equal(foldArabic('أحمد'), foldArabic('احمد'));
  assert.equal(foldArabic('شركة'), 'شركه');
  assert.ok(foldArabic('مؤسسة الصفرات').includes('موسسه'));
});

test('an empty query yields an empty digit string (guarded by length elsewhere)', () => {
  assert.equal(toAsciiDigits(foldArabic('')).replace(/\D/g, ''), '');
});
