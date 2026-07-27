import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatGoogleAdsCustomerId,
  googleAdsAccountDisplayName,
  googleAdsAccountNameMissing,
  isGeneratedFallbackName,
} from '../lib/accounts/display';
import {
  normalizeCustomerId,
  pickPreferredGoogleAdsAccount,
  pickSelectedAdsAccount,
} from '../lib/accounts/selection';

test('customer IDs are formatted for display without ever becoming the account name', () => {
  assert.equal(formatGoogleAdsCustomerId('7561141000'), '756-114-1000');
  assert.equal(formatGoogleAdsCustomerId('756-114-1000'), '756-114-1000');
  assert.equal(formatGoogleAdsCustomerId(''), '—');
  assert.equal(formatGoogleAdsCustomerId(null), '—');

  // A bare number or generated fallback must never be treated as a real name.
  assert.equal(
    googleAdsAccountDisplayName({ customer_id: '7561141000', customer_name: null }),
    'حساب إعلاني غير مُسمّى'
  );
  assert.equal(
    googleAdsAccountDisplayName({ customer_id: '7561141000', customer_name: 'Google Ads 756-114-1000' }),
    'حساب إعلاني غير مُسمّى'
  );
  assert.equal(
    googleAdsAccountDisplayName({ customer_id: '4201238455', customer_name: 'الصفرات' }),
    'الصفرات'
  );
});

test('generated fallback names are detected so repair can replace them', () => {
  assert.equal(isGeneratedFallbackName('Google Ads 420-123-8455'), true);
  assert.equal(isGeneratedFallbackName('حساب بدون اسم'), true);
  assert.equal(isGeneratedFallbackName('متجر الصفرات'), false);
  assert.equal(googleAdsAccountNameMissing({ customer_name: '  ' }), true);
  assert.equal(googleAdsAccountNameMissing({ customer_name: 'مطعم دومن' }), false);
});

test('normalizeCustomerId strips every non-digit form Google may return', () => {
  assert.equal(normalizeCustomerId('customers/7561141000'), '7561141000');
  assert.equal(normalizeCustomerId('756-114-1000'), '7561141000');
  assert.equal(normalizeCustomerId(''), '');
});

test('the preferred first account is a named enabled client, never the configured MCC', () => {
  const previousMcc = process.env.GOOGLE_ADS_MCC_CUSTOMER_ID;
  process.env.GOOGLE_ADS_MCC_CUSTOMER_ID = '7561141000';
  try {
    const saved = [
      { id: 'mcc', customer_id: '7561141000' },
      { id: 'named', customer_id: '4201238455' },
      { id: 'unnamed', customer_id: '1234567890' },
    ];
    const discovered = [
      { customer_id: '7561141000', customer_name: 'مُضاعفة للتسويق', status: 'ENABLED' },
      { customer_id: '4201238455', customer_name: 'الصفرات', status: 'ENABLED', currency_code: 'SAR' },
      { customer_id: '1234567890', customer_name: null, status: 'SUSPENDED' },
    ];

    const preferred = pickPreferredGoogleAdsAccount(saved, discovered);
    assert.equal(preferred?.id, 'named');
  } finally {
    if (previousMcc === undefined) delete process.env.GOOGLE_ADS_MCC_CUSTOMER_ID;
    else process.env.GOOGLE_ADS_MCC_CUSTOMER_ID = previousMcc;
  }
});

test('pickPreferredGoogleAdsAccount tolerates missing discovery data', () => {
  assert.equal(pickPreferredGoogleAdsAccount(null), null);
  assert.equal(pickPreferredGoogleAdsAccount([]), null);
  const onlySaved = [{ customer_id: '9999999999' }];
  assert.equal(pickPreferredGoogleAdsAccount(onlySaved)?.customer_id, '9999999999');
});

test('selected account uses a valid cookie before the persisted preference', () => {
  const accounts = [
    { customer_id: '1111111111' },
    { customer_id: '2222222222' },
  ];

  assert.equal(
    pickSelectedAdsAccount(accounts, '222-222-2222', '1111111111')?.customer_id,
    '2222222222'
  );
});

test('selected account survives sign-out through its persisted user preference', () => {
  const accounts = [
    { customer_id: '1111111111' },
    { customer_id: '2222222222' },
  ];

  assert.equal(
    pickSelectedAdsAccount(accounts, null, '222-222-2222')?.customer_id,
    '2222222222'
  );
});

test('stale selection safely falls back to the first linked account', () => {
  const accounts = [{ customer_id: '1111111111' }];

  assert.equal(
    pickSelectedAdsAccount(accounts, '9999999999', '8888888888')?.customer_id,
    '1111111111'
  );
  assert.equal(pickSelectedAdsAccount([], null, null), null);
});
