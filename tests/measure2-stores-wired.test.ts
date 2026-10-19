import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64');

import { encrypt, decrypt } from '../lib/crypto';
import { getStoreAccessToken, needsRefresh } from '../lib/stores/tokens';
import type { StoreOAuthConfig } from '../lib/stores/oauth';
import { buildShopifyAuthUrl, normalizeShopDomain, shopifyConfig } from '../lib/stores/oauth';
import { shopifyHmac, verifyShopifyQuery, verifyShopifyWebhook } from '../lib/stores/signature';
import { normalizeShopifyOrder } from '../lib/stores/orders';
import { isStorePlatform, newStoreState, parseStoreState, storePurpose } from '../lib/stores/state';
import { loadStoreRevenue, storeRevenueBlock, storeRevenueLine } from '../lib/stores/revenue';
import { compareRevenue } from '../lib/stores/orders';
import { loopsPromptAddendum } from '../lib/loops/prompt';
import { buildMoneyReport, moneyReportLines } from '../lib/loops/monthly';
import { buildConnectionsView } from '../lib/settings/connections';
import { answeringSpan } from '../lib/google-read/gbp';
import { loadGbpHoursEvidence } from '../lib/google-read/gbp-evidence';
import { createHmac } from 'node:crypto';

const cfg: StoreOAuthConfig = { platform: 'salla', clientId: 'id', clientSecret: 'sec', redirectUri: 'https://x.test/cb', authorizeUrl: 'https://a.test', tokenUrl: 'https://t.test/token', scope: 'offline_access' };

// A tiny in-memory store_connections table with an atomic lease, like the SQL function.
function fakeDb(row: Record<string, any>) {
  const calls = { rpc: 0 };
  const db = {
    row,
    calls,
    from() {
      let patch: any = null;
      const q: any = {
        select: () => q,
        eq: () => q,
        update: (p: any) => { patch = p; return q; },
        maybeSingle: async () => ({ data: { ...row }, error: null }),
        then: (res: any) => { if (patch) Object.assign(row, patch); res({ error: null }); },
      };
      return q;
    },
    async rpc() {
      calls.rpc++;
      const free = !row.refresh_lease_until || row.refresh_lease_until < Date.now();
      if (free) { row.refresh_lease_until = Date.now() + 30000; return { data: true, error: null }; }
      return { data: false, error: null };
    },
  };
  return db;
}

test('needsRefresh margin', () => {
  const now = new Date('2026-10-20T00:00:00Z');
  assert.equal(needsRefresh({ token_expires_at: null }, now), true);
  assert.equal(needsRefresh({ token_expires_at: '2026-10-20T00:03:00Z' }, now), true);
  assert.equal(needsRefresh({ token_expires_at: '2026-10-20T01:00:00Z' }, now), false);
});

test('fresh token is returned without refresh', async () => {
  const db = fakeDb({ id: 'c', status: 'active', access_token_encrypted: encrypt('AT'), refresh_token_encrypted: encrypt('RT'), token_expires_at: new Date(Date.now() + 3600e3).toISOString() });
  assert.equal(await getStoreAccessToken(db, 'c', cfg), 'AT');
  assert.equal(db.calls.rpc, 0);
});

test('refresh saves BOTH new tokens and releases the lease', async () => {
  const db = fakeDb({ id: 'c', status: 'active', access_token_encrypted: encrypt('old'), refresh_token_encrypted: encrypt('RT1'), token_expires_at: new Date(Date.now() - 1000).toISOString(), refresh_lease_until: null });
  let sent = '';
  const fetchImpl = (async (_u: string, init: any) => { sent = String(init.body); return new Response(JSON.stringify({ access_token: 'new', refresh_token: 'RT2', expires_in: 1209600 }), { status: 200 }); }) as unknown as typeof fetch;
  const token = await getStoreAccessToken(db, 'c', cfg, { fetchImpl });
  assert.equal(token, 'new');
  assert.match(sent, /refresh_token=RT1/);
  assert.equal(decrypt(db.row.refresh_token_encrypted), 'RT2');
  assert.equal(db.row.refresh_lease_until, null);
});

test('lease held by someone else: no token call, waits then gives up or uses their result', async () => {
  const row: Record<string, any> = { id: 'c', status: 'active', access_token_encrypted: encrypt('old'), refresh_token_encrypted: encrypt('RT1'), token_expires_at: new Date(Date.now() - 1000).toISOString(), refresh_lease_until: Date.now() + 60000 };
  const db = fakeDb(row);
  let hit = 0;
  const fetchImpl = (async () => { hit++; return new Response('{}', { status: 200 }); }) as unknown as typeof fetch;
  // The other worker finishes while we wait.
  const sleep = async () => { row.access_token_encrypted = encrypt('theirs'); row.token_expires_at = new Date(Date.now() + 3600e3).toISOString(); };
  assert.equal(await getStoreAccessToken(db, 'c', cfg, { fetchImpl, sleep }), 'theirs');
  assert.equal(hit, 0);
  const stuck = fakeDb({ ...row, token_expires_at: new Date(Date.now() - 1000).toISOString(), refresh_lease_until: Date.now() + 60000 });
  assert.equal(await getStoreAccessToken(stuck, 'c', cfg, { fetchImpl, sleep: async () => {}, waitAttempts: 2 }), null);
  assert.equal(hit, 0);
});

test('rejected refresh marks the connection error and never retries', async () => {
  const db = fakeDb({ id: 'c', status: 'active', access_token_encrypted: encrypt('old'), refresh_token_encrypted: encrypt('RT1'), token_expires_at: new Date(Date.now() - 1000).toISOString(), refresh_lease_until: null });
  const fetchImpl = (async () => new Response('{}', { status: 400 })) as unknown as typeof fetch;
  assert.equal(await getStoreAccessToken(db, 'c', cfg, { fetchImpl }), null);
  assert.equal(db.row.status, 'error');
});

test('store state and shopify helpers', () => {
  const s = newStoreState('zid');
  assert.deepEqual(parseStoreState(s), { platform: 'zid' });
  assert.equal(parseStoreState('evil~00'), null);
  assert.equal(isStorePlatform('shopify'), false);
  assert.equal(storePurpose('shopify'), 'store_shopify');
  assert.equal(normalizeShopDomain('My-Store.myshopify.com'), 'my-store.myshopify.com');
  assert.equal(normalizeShopDomain('evil.com/x.myshopify.com'), null);
  assert.equal(normalizeShopDomain('a.myshopify.com.evil.com'), null);
  const c = shopifyConfig({ SHOPIFY_CLIENT_ID: 'i', SHOPIFY_CLIENT_SECRET: 's', SHOPIFY_REDIRECT_URI: 'https://x.test/cb' });
  assert.ok(c);
  assert.match(buildShopifyAuthUrl(c, 'a.myshopify.com', 'st'), /^https:\/\/a\.myshopify\.com\/admin\/oauth\/authorize\?/);
});

test('shopify webhook hmac and redirect hmac', () => {
  const body = '{"id":1}';
  assert.equal(verifyShopifyWebhook({ secret: 'k', hmacHeader: shopifyHmac('k', body), rawBody: body }).ok, true);
  assert.equal(verifyShopifyWebhook({ secret: 'k', hmacHeader: shopifyHmac('k', body), rawBody: body + ' ' }).ok, false);
  assert.equal(verifyShopifyWebhook({ secret: 'k', hmacHeader: null, rawBody: body }).ok, false);
  const msg = 'code=abc&shop=a.myshopify.com&state=s&timestamp=1';
  const hmac = createHmac('sha256', 'k').update(msg).digest('hex');
  assert.equal(verifyShopifyQuery('k', new URLSearchParams(`shop=a.myshopify.com&timestamp=1&state=s&code=abc&hmac=${hmac}`)).ok, true);
  assert.equal(verifyShopifyQuery('k', new URLSearchParams(`shop=b.myshopify.com&timestamp=1&state=s&code=abc&hmac=${hmac}`)).ok, false);
  assert.equal(verifyShopifyQuery('k', new URLSearchParams('shop=a.myshopify.com')).ok, false);
});

test('shopify order normalisation reads gclid from landing_site', () => {
  const o = normalizeShopifyOrder('orders/create', { id: 99, total_price: '149.50', currency: 'sar', created_at: '2026-10-19T10:00:00+03:00', landing_site: '/?gclid=Cj0KCQjw_abcdefghijklmnop&utm_source=google', note: 'M-ABCD' });
  assert.ok(o);
  assert.equal(o.total, 149.5);
  assert.equal(o.gclid, 'Cj0KCQjw_abcdefghijklmnop');
  assert.equal(o.utm_source, 'google');
  assert.equal(o.ref_code, 'M-ABCD');
  assert.equal(normalizeShopifyOrder('orders/cancelled', { id: 1, total_price: '5', cancelled_at: '2026-10-19T10:00:00Z' })?.cancelled, true);
  assert.equal(normalizeShopifyOrder('orders/create', { id: 1 }), null);
});

test('revenue: reads active connections of the account, compact block, prompt and money line', async () => {
  const orders = Array.from({ length: 12 }, (_, i) => ({ total: '100', cancelled: false, lead_click_id: i < 3 ? 'x' : null }));
  const db = {
    from(table: string) {
      const q: any = { select: () => q, eq: () => q, in: () => q, gte: () => q, lt: () => q, limit: async () => ({ data: orders, error: null }) };
      if (table === 'store_connections') { q.eq = () => ({ eq: async () => ({ data: [{ id: 'c1' }], error: null }) }); }
      return q;
    },
  };
  const cmp = await loadStoreRevenue(db, 'acc', 'a', 'b', 2400);
  assert.equal(cmp?.store_revenue, 1200);
  const block = storeRevenueBlock(cmp, 30);
  assert.equal(block?.verdict, 'google_overstates');
  assert.equal(storeRevenueBlock(compareRevenue({ orders: [], googleReportedValue: 5 }), 30), null);
  assert.match(loopsPromptAddendum({ store_revenue: block }), /store_revenue/);
  assert.equal(loopsPromptAddendum({}), '');
  const base = { month: '2026-09', currency: 'SAR', current: { cost: 1000, conversions: 10, conversion_value: 2400 }, prior: null, wasted: null, protectedOutcome: { amount: 0, actions: 0 } };
  const off = moneyReportLines(buildMoneyReport(base));
  const on = moneyReportLines(buildMoneyReport({ ...base, storeRevenue: block }));
  assert.equal(on.length, off.length + 1);
  assert.deepEqual(on.slice(0, off.length), off);
  assert.match(storeRevenueLine(block!, 'SAR'), /أكثر من مبيعات المتجر/);
});

test('settings view: flags, rows and outcome', () => {
  assert.equal(buildConnectionsView({ params: undefined, grants: null, stores: [], env: {} }).show, false);
  const v = buildConnectionsView({
    params: { extra: 'missing_scope', feature: 'ga4' },
    grants: { data_manager: 'none', ga4: 'active', gbp: 'none' },
    stores: [{ platform: 'salla', external_store_id: '77', status: 'error' }],
    env: { GA4_READ_ENABLED: 'true', STORE_SYNC_ENABLED: 'true' },
  });
  assert.equal(v.show, true);
  assert.deepEqual(v.google.map((g) => g.feature), ['ga4']);
  assert.equal(v.google[0].label, 'مربوط');
  assert.equal(v.stores.find((s) => s.platform === 'salla')?.status, 'needs_reconnect');
  assert.equal(v.stores.find((s) => s.platform === 'shopify')?.needsShop, true);
  assert.equal(v.notice?.tone, 'warning');
  // An outcome for an unknown feature is not echoed.
  assert.equal(buildConnectionsView({ params: { extra: 'connected', feature: 'zzz' }, grants: null, stores: [], env: { GA4_READ_ENABLED: 'true' } }).notice, null);
});

test('gbp evidence: answering span, and nothing at all while the flag is off', async () => {
  assert.deepEqual(answeringSpan([[9, 13], [16, 22]]), { open: 9, close: 22 });
  assert.equal(answeringSpan([]), null);
  delete process.env.GBP_READ_ENABLED;
  assert.equal(await loadGbpHoursEvidence({ db: {}, userId: 'u', callHoursChoice: 'day_8_23' }), null);
});
