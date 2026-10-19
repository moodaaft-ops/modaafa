import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sallaSignature, verifySallaWebhook, verifyZidWebhook } from '../lib/stores/signature';
import { compareRevenue, matchOrderToClick, normalizeOrderEvent } from '../lib/stores/orders';
import { buildStoreAuthUrl, storeOAuthConfig } from '../lib/stores/oauth';
import { isStoreSyncEnabled } from '../lib/stores/flags';
import { newExtraState, parseExtraState, evaluateGrant, callbackRedirect } from '../lib/google-auth/state';
import { buildGa4Request, ga4PropertyId, parseGa4Report } from '../lib/google-read/ga4';
import { gbpHoursEvidence, parseGbpLocation } from '../lib/google-read/gbp';

const body = JSON.stringify({ event: 'order.created', merchant: 7 });

test('salla signature: valid, tampered, missing, none strategy', () => {
  const sig = sallaSignature('s3', body);
  const base = { secret: 's3', strategy: 'signature', authorization: null, rawBody: body };
  assert.equal(verifySallaWebhook({ ...base, signature: sig }).ok, true);
  assert.equal(verifySallaWebhook({ ...base, signature: sig, rawBody: body + ' ' }).ok, false);
  assert.equal(verifySallaWebhook({ ...base, signature: null }).ok, false);
  assert.equal(verifySallaWebhook({ ...base, signature: sig, strategy: 'none' }).ok, false);
  assert.equal(verifySallaWebhook({ ...base, signature: null, strategy: 'token', tokenHeader: 's3' }).ok, true);
  assert.equal(verifySallaWebhook({ ...base, signature: null, strategy: 'token', tokenHeader: 'x' }).ok, false);
});

test('zid: needs url secret and basic auth', () => {
  const auth = 'Basic ' + Buffer.from('u:p').toString('base64');
  const a = { urlSecret: 'k', username: 'u', password: 'p' };
  assert.equal(verifyZidWebhook({ ...a, presentedUrlSecret: 'k', authorization: auth }).ok, true);
  assert.equal(verifyZidWebhook({ ...a, presentedUrlSecret: 'bad', authorization: auth }).ok, false);
  assert.equal(verifyZidWebhook({ ...a, presentedUrlSecret: 'k', authorization: null }).ok, false);
  assert.equal(verifyZidWebhook({ ...a, presentedUrlSecret: 'k', authorization: 'Basic ' + Buffer.from('u:x').toString('base64') }).ok, false);
});

test('order normalisation and matching', () => {
  const o = normalizeOrderEvent('salla', { event: 'order.updated', data: { id: 55, total: { amount: 230.5, currency: 'SAR' }, status: { slug: 'completed' }, customer_note: 'ref M-ABCD thanks', gclid: 'Cj0KCQjw_abcdefghijklmnop' } });
  assert.ok(o);
  assert.equal(o.total, 230.5);
  assert.equal(o.ref_code, 'M-ABCD');
  assert.equal(o.cancelled, false);
  assert.equal(normalizeOrderEvent('salla', { event: 'order.created', data: {} }), null);
  assert.equal(normalizeOrderEvent('zid', { event: 'order.status.update', data: { id: 1, total: 5, status: 'cancelled' } })?.cancelled, true);
  const clicks = [{ id: 'c1', gclid: 'Cj0KCQjw_abcdefghijklmnop', ref_code: 'M-ZZZZ' }, { id: 'c2', gclid: null, ref_code: 'M-ABCD' }];
  assert.deepEqual(matchOrderToClick(o, clicks), { method: 'gclid', click_id: 'c1' });
  assert.deepEqual(matchOrderToClick({ gclid: null, ref_code: 'M-ABCD' }, clicks), { method: 'ref_code', click_id: 'c2' });
  assert.deepEqual(matchOrderToClick({ gclid: null, ref_code: null }, clicks), { method: 'none', click_id: null });
});

test('revenue comparison verdicts', () => {
  const orders = Array.from({ length: 12 }, (_, i) => ({ total: 100, cancelled: i === 0, attributed: i < 4 }));
  const r = compareRevenue({ orders, googleReportedValue: 2000 });
  assert.equal(r.store_revenue, 1100);
  assert.equal(r.verdict, 'google_overstates');
  assert.equal(compareRevenue({ orders: orders.slice(0, 3), googleReportedValue: 10 }).verdict, 'insufficient_data');
  assert.equal(compareRevenue({ orders, googleReportedValue: 1000 }).verdict, 'consistent');
});

test('store oauth reads env only and flag defaults off', () => {
  assert.equal(storeOAuthConfig('salla', {}), null);
  const cfg = storeOAuthConfig('salla', { SALLA_CLIENT_ID: 'id', SALLA_CLIENT_SECRET: 'sec', SALLA_REDIRECT_URI: 'https://x.test/cb' });
  assert.ok(cfg);
  const url = new URL(buildStoreAuthUrl(cfg, 'st'));
  assert.equal(url.searchParams.get('state'), 'st');
  assert.equal(url.searchParams.get('scope'), 'offline_access');
  assert.equal(isStoreSyncEnabled({}), false);
  assert.equal(isStoreSyncEnabled({ STORE_SYNC_ENABLED: 'true' }), true);
});

test('incremental auth state', () => {
  const s = newExtraState('ga4');
  assert.deepEqual(parseExtraState(s), { feature: 'ga4' });
  assert.equal(parseExtraState('nope~zz'), null);
  assert.equal(parseExtraState(42), null);
  assert.equal(evaluateGrant('ga4', { scope: 'https://www.googleapis.com/auth/analytics.readonly', refresh_token: 'r' }).ok, true);
  assert.equal(evaluateGrant('ga4', { scope: 'https://www.googleapis.com/auth/analytics.readonly' }).ok, false);
  assert.equal(evaluateGrant('ga4', { scope: 'https://www.googleapis.com/auth/adwords', refresh_token: 'r' }).ok, false);
  assert.match(callbackRedirect('gbp', 'granted'), /^\/settings\?extra=granted&feature=gbp$/);
});

test('ga4 request and parse', () => {
  assert.equal(ga4PropertyId('properties/123456'), '123456');
  assert.equal(ga4PropertyId('abc'), null);
  assert.equal(buildGa4Request(500).dateRanges[0].startDate, '90daysAgo');
  const r = parseGa4Report('1', 30, { rows: [
    { dimensionValues: [{ value: '/a' }], metricValues: ['100', '20', '0.2', '15', '1'].map((value) => ({ value })) },
    { dimensionValues: [{ value: '/b' }], metricValues: [{ value: 'x' }] },
  ] });
  assert.equal(r.rows.length, 1);
  assert.equal(r.weak_pages.length, 1);
});

test('gbp parse and hours evidence', () => {
  const p = parseGbpLocation(
    { title: 'عيادة', openInfo: { status: 'OPEN' }, regularHours: { periods: [{ openDay: 'SUNDAY', openTime: { hours: 9 }, closeTime: { hours: 21 } }] } },
    { averageRating: 4.6, totalReviewCount: 80 }
  );
  assert.equal(p.rating, 4.6);
  assert.equal(p.profile_state, 'open');
  assert.equal(gbpHoursEvidence(p.periods, { open: 9, close: 21 })?.agrees, true);
  assert.equal(gbpHoursEvidence(p.periods, { open: 14, close: 23 })?.agrees, false);
  assert.equal(gbpHoursEvidence([], null), null);
});
