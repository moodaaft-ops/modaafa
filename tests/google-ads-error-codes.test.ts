import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getGoogleAdsErrorCodes,
  googleAdsAuthNeedsReconnect,
  GoogleAdsRestError,
  retryAfterMs,
} from '../lib/google-ads/client';
import { ManagerAccountError } from '../lib/google-ads/sync';

test('ManagerAccountError is classified through its code property, not the message', () => {
  const error = new ManagerAccountError('7561141000');
  // The message says "Refusing to request metrics for manager account …" —
  // no classifier substring — so before the fix this returned [].
  assert.ok(getGoogleAdsErrorCodes(error).includes('REQUESTED_METRICS_FOR_MANAGER'));
});

test('message-substring classification still works', () => {
  const error = new Error('Request failed: USER_PERMISSION_DENIED for customer');
  assert.deepEqual(getGoogleAdsErrorCodes(error), ['USER_PERMISSION_DENIED']);
});

test('lowercase/system error codes (ECONNRESET-style) do not leak false Google codes', () => {
  const error = Object.assign(new Error('socket hang up'), { code: 'econnreset' });
  assert.deepEqual(getGoogleAdsErrorCodes(error), []);
});

test('GoogleAdsRestError keeps returning its own parsed codes', () => {
  const error = new GoogleAdsRestError(400, 'bad', ['REQUESTED_METRICS_FOR_MANAGER']);
  assert.deepEqual(getGoogleAdsErrorCodes(error), ['REQUESTED_METRICS_FOR_MANAGER']);
});

test('a manager-account error never reads as a reconnect problem', () => {
  assert.equal(googleAdsAuthNeedsReconnect(new ManagerAccountError('123')), false);
});

test('retryAfterMs surfaces the server-provided penalty window', () => {
  assert.equal(retryAfterMs(new GoogleAdsRestError(429, 'quota', [], null, 30)), 30_000);
  assert.equal(retryAfterMs(new GoogleAdsRestError(429, 'quota', [], null, null)), null);
  assert.equal(retryAfterMs(new Error('quota')), null);
});
