import assert from 'node:assert/strict';
import test from 'node:test';

import { encodeGoogleAdsOAuthStates } from '../lib/auth/google-ads-oauth-state';
import { validateGoogleAdsOAuthState } from '../lib/auth/oauth-state-validation';
import { buildGoogleAdsLinkRows } from '../lib/google-ads/link-account-rows';

test('OAuth state accepts durable storage or the cookie only during storage outage', () => {
  const cookieValue = encodeGoogleAdsOAuthStates(['state-a']);

  assert.deepEqual(
    validateGoogleAdsOAuthState({
      serverResult: 'ok',
      cookieValue: undefined,
      returnedState: 'state-a',
    }),
    { accepted: true, usedCookieFallback: false },
  );
  assert.deepEqual(
    validateGoogleAdsOAuthState({
      serverResult: 'unavailable',
      cookieValue,
      returnedState: 'state-a',
    }),
    { accepted: true, usedCookieFallback: true },
  );
});

test('a cookie cannot rescue a missing or cross-user OAuth state', () => {
  const cookieValue = encodeGoogleAdsOAuthStates(['state-a']);

  assert.deepEqual(
    validateGoogleAdsOAuthState({
      serverResult: 'not_found',
      cookieValue,
      returnedState: 'state-a',
    }),
    { accepted: false, error: 'state_mismatch' },
  );
  assert.deepEqual(
    validateGoogleAdsOAuthState({
      serverResult: 'user_mismatch',
      cookieValue,
      returnedState: 'state-a',
    }),
    { accepted: false, error: 'state_user_mismatch' },
  );
});

test('reconnecting a revoked account makes it active without erasing its real name', () => {
  const rows = buildGoogleAdsLinkRows({
    businessId: 'business-1',
    encryptedRefreshToken: 'encrypted-token',
    accounts: [{ customer_id: '123-456-7890', status: 'ENABLED' }],
    existingMetadata: new Map([
      ['1234567890', { customer_name: 'مراكز الأمواج', manager_id: '7561141000' }],
    ]),
  });

  assert.equal(rows[0].customer_id, '1234567890');
  assert.equal(rows[0].customer_name, 'مراكز الأمواج');
  assert.equal(rows[0].manager_id, '7561141000');
  assert.equal(rows[0].status, 'active');
});

test('a generated fallback name never overwrites a later Google name repair', () => {
  const [row] = buildGoogleAdsLinkRows({
    businessId: 'business-1',
    encryptedRefreshToken: 'encrypted-token',
    accounts: [{ customer_id: '1234567890', customer_name: 'اسم Google الحقيقي' }],
    existingMetadata: new Map([
      ['1234567890', { customer_name: 'Google Ads 123-456-7890' }],
    ]),
  });

  assert.equal(row.customer_name, 'اسم Google الحقيقي');
});
