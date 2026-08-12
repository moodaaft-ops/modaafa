import test from 'node:test';
import assert from 'node:assert/strict';
import {
  foldArabicSearch,
  searchGoogleAdsAccounts,
  toAsciiDigits,
} from '../lib/accounts/search';

const accounts = [
  { id: 'one', customer_id: '7561141000', customer_name: 'شركة أحمد' },
  { id: 'two', customer_id: '4201238455', customer_name: 'مؤسسة الصفرات' },
];

test('Arabic-Indic digits map to ASCII so numeric account search works', () => {
  assert.equal(toAsciiDigits('٧٥٦١١٤').replace(/\D/g, ''), '756114');
  assert.equal(toAsciiDigits('۷۵۶').replace(/\D/g, ''), '756'); // Persian digits
  assert.equal(toAsciiDigits('756-114').replace(/\D/g, ''), '756114'); // ASCII unchanged
});

test('a real customer id is matched when typed in Arabic digits', () => {
  assert.deepEqual(searchGoogleAdsAccounts(accounts, '٧٥٦').map((account) => account.id), ['one']);
});

test('Arabic letter variants fold so name search is forgiving', () => {
  assert.equal(foldArabicSearch('أحمد'), foldArabicSearch('احمد'));
  assert.equal(foldArabicSearch('شركة'), 'شركه');
  assert.ok(foldArabicSearch('مؤسسة الصفرات').includes('موسسه'));
  assert.deepEqual(searchGoogleAdsAccounts(accounts, 'احمد').map((account) => account.id), ['one']);
});

test('an empty query yields an empty digit string (guarded by length elsewhere)', () => {
  assert.equal(toAsciiDigits(foldArabicSearch('')).replace(/\D/g, ''), '');
  assert.equal(searchGoogleAdsAccounts(accounts, '').length, accounts.length);
});
