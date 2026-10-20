import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GoogleAdsRestError } from '@/lib/google-ads/client';
import {
  buildIngestRequest,
  conversionActionId,
  consentFromEnv,
  DataManagerError,
  formatEventTimestamp,
  isDataManagerAccessError,
  isDataManagerInvalidRequest,
  parseDataManagerError,
  type DataManagerRequest,
} from '@/lib/google-ads/data-manager';
import { uploadLeadConversions } from '@/lib/lead-loop/upload-service';
import {
  isLegacyBlockedError,
  LEGACY_BLOCKED_CODE,
  normalizePreference,
  planChannels,
  responseSaysLegacyBlocked,
} from '@/lib/lead-loop/transports';

const RES = 'customers/1234567890/conversionActions/555';
const NOW = new Date('2026-10-19T12:00:00Z');
const account = { id: 'acc', customerId: '123-456-7890', loginCustomerId: '999-888-7777', timeZone: 'Asia/Riyadh' };
const lead = (over: Record<string, unknown> = {}) => ({
  id: '11111111-1111-4111-8111-111111111111',
  gclid: 'Cj0KCQiAabcdef123456',
  clicked_at: '2026-10-18T10:00:00Z',
  marked_at: '2026-10-19T09:30:00Z',
  value_sar: 450,
  ...over,
});

function fakeDb(claimed: any[]) {
  const updates: Array<{ table: string; patch: any; filters: Record<string, unknown> }> = [];
  const inserts: Array<{ table: string; rows: any[] }> = [];
  let claims = 0;
  return {
    updates,
    inserts,
    get claims() {
      return claims;
    },
    rpc: async () => {
      claims += 1;
      return { data: claims === 1 ? claimed : [], error: null };
    },
    from(table: string) {
      return {
        select() {
          const q: any = { eq() { return q; }, in() { return q; }, then(resolve: any) { resolve({ data: claimed, error: null }); } };
          return q;
        },
        update(patch: any) {
          const filters: Record<string, unknown> = {};
          const q: any = {
            eq(k: string, v: unknown) { filters[k] = v; return q; },
            in(k: string, v: unknown) { filters[k] = v; return q; },
            then(resolve: any) { updates.push({ table, patch, filters }); resolve({ error: null }); },
          };
          return q;
        },
        insert: async (rows: any) => { inserts.push({ table, rows }); return { error: null }; },
      };
    },
  };
}

const legacyBlocked = () => new GoogleAdsRestError(400, 'Customer is not allowlisted', [LEGACY_BLOCKED_CODE]);

test('verdict on the legacy block: the allowlist code is detected in codes, in the message and in a 200 body', () => {
  assert.equal(isLegacyBlockedError(legacyBlocked()), true);
  assert.equal(isLegacyBlockedError(new Error(`x ${LEGACY_BLOCKED_CODE} y`)), true);
  assert.equal(isLegacyBlockedError(new GoogleAdsRestError(500, 'boom', ['INTERNAL_ERROR'])), false);
  const body = { partialFailureError: { details: [{ errors: [{ errorCode: { authorizationError: LEGACY_BLOCKED_CODE }, message: 'no' }] }] } };
  assert.equal(responseSaysLegacyBlocked(body), true);
  assert.equal(responseSaysLegacyBlocked({ results: [{}] }), false);
});

test('channel plan: Data Manager first, legacy as fallback, nothing when both are closed', () => {
  assert.deepEqual(planChannels({ dataManagerAvailable: true, preference: 'auto', legacyBlocked: false }), ['data_manager', 'legacy']);
  assert.deepEqual(planChannels({ dataManagerAvailable: true, preference: 'auto', legacyBlocked: true }), ['data_manager']);
  assert.deepEqual(planChannels({ dataManagerAvailable: false, preference: 'auto', legacyBlocked: false }), ['legacy']);
  assert.deepEqual(planChannels({ dataManagerAvailable: false, preference: 'auto', legacyBlocked: true }), []);
  assert.deepEqual(planChannels({ dataManagerAvailable: true, preference: 'legacy', legacyBlocked: false }), ['legacy']);
  assert.deepEqual(planChannels({ dataManagerAvailable: false, preference: 'data_manager', legacyBlocked: false }), []);
  assert.equal(normalizePreference('weird'), 'auto');
  assert.equal(normalizePreference('legacy'), 'legacy');
});

test('Data Manager request: destination, click id, transaction id, account-zone timestamp, SAR value', () => {
  const built = buildIngestRequest([lead(), lead({ id: 'g', gclid: null, gbraid: 'GB1' }), lead({ id: 'w', gclid: null, wbraid: 'WB1' }), lead({ id: 'none', gclid: null })], {
    customerId: '123-456-7890',
    loginCustomerId: '999-888-7777',
    conversionAction: RES,
    timeZone: 'Asia/Riyadh',
  });
  assert.ok(!('error' in built));
  if ('error' in built) return;
  assert.deepEqual(built.request.destinations, [
    {
      operatingAccount: { accountType: 'GOOGLE_ADS', accountId: '1234567890' },
      loginAccount: { accountType: 'GOOGLE_ADS', accountId: '9998887777' },
      productDestinationId: '555',
    },
  ]);
  assert.equal(built.request.events.length, 3);
  assert.deepEqual(built.request.events[0].adIdentifiers, { gclid: 'Cj0KCQiAabcdef123456' });
  assert.deepEqual(built.request.events[1].adIdentifiers, { gbraid: 'GB1' });
  assert.deepEqual(built.request.events[2].adIdentifiers, { wbraid: 'WB1' });
  assert.equal(built.request.events[0].transactionId, lead().id);
  assert.equal(built.request.events[0].eventTimestamp, '2026-10-19T12:30:00+03:00');
  assert.equal(built.request.events[0].conversionValue, 450);
  assert.equal(built.request.events[0].currency, 'SAR');
  assert.deepEqual(built.skipped, [{ leadId: 'none', reason: 'no_click_id' }]);
  // no user data, so no encoding and no consent unless asked
  assert.equal('encoding' in built.request, false);
  assert.equal('consent' in built.request, false);
  assert.equal(formatEventTimestamp(new Date('2026-01-01T22:30:00Z'), 'America/New_York'), '2026-01-01T17:30:00-05:00');
});

test('Data Manager request: hashed identifiers only when present and well formed, consent only when configured', () => {
  const hash = 'a'.repeat(64);
  const built = buildIngestRequest(
    [
      { ...lead(), email_sha256: hash, phone_sha256: 'not-a-hash' },
      lead({ id: 'plain' }),
    ] as any,
    { customerId: '1234567890', conversionAction: RES, consent: 'granted' }
  );
  assert.ok(!('error' in built));
  if ('error' in built) return;
  assert.deepEqual(built.request.events[0].userData, { userIdentifiers: [{ emailAddress: hash }] });
  assert.equal(built.request.events[1].userData, undefined);
  assert.equal(built.request.encoding, 'HEX');
  assert.deepEqual(built.request.consent, { adUserData: 'CONSENT_GRANTED', adPersonalization: 'CONSENT_GRANTED' });
  assert.equal(consentFromEnv({ DATA_MANAGER_CONSENT: 'Granted' }), 'granted');
  assert.equal(consentFromEnv({ DATA_MANAGER_CONSENT: 'maybe' }), null);
  assert.equal(consentFromEnv({}), null);
  const denied = buildIngestRequest([lead()], { customerId: '1', conversionAction: RES, consent: 'denied', validateOnly: true });
  assert.ok(!('error' in denied));
  if (!('error' in denied)) {
    assert.equal(denied.request.consent?.adUserData, 'CONSENT_DENIED');
    assert.equal(denied.request.validateOnly, true);
  }
});

test('Data Manager request: a conversion action that is not a resource name is refused before anything is sent', () => {
  assert.equal(conversionActionId(RES), '555');
  assert.equal(conversionActionId('555'), null);
  assert.deepEqual(buildIngestRequest([lead()], { customerId: '1', conversionAction: 'nope' }), { error: 'invalid_conversion_action' });
  assert.deepEqual(buildIngestRequest([lead()], { customerId: 'abc', conversionAction: RES }), { error: 'invalid_customer' });
});

test('Data Manager errors are classified from the Google error body', () => {
  const denied = parseDataManagerError(403, { error: { code: 403, status: 'PERMISSION_DENIED', message: 'Request had insufficient authentication scopes.' } });
  assert.equal(isDataManagerAccessError(denied), true);
  assert.equal(isDataManagerInvalidRequest(denied), false);
  const invalid = parseDataManagerError(400, { error: { status: 'INVALID_ARGUMENT', message: 'bad gclid', details: [{ reason: 'INVALID_GCLID' }] } });
  assert.equal(isDataManagerInvalidRequest(invalid), true);
  assert.deepEqual(invalid.reasons, ['INVALID_GCLID']);
  assert.equal(isDataManagerAccessError(new Error('x')), false);
});

const dmChannels = (sender: (r: DataManagerRequest) => Promise<any>, over: Record<string, unknown> = {}) => ({
  dataManagerAvailable: true,
  makeDataManagerSender: async () => sender,
  preference: 'auto' as const,
  legacyBlocked: false,
  consent: null,
  ...over,
});

test('service: with channels the Data Manager goes first, legacy is not touched, the channel and request id are logged', async () => {
  const db = fakeDb([{ ...lead({ id: 'a' }), upload_attempts: 0 }, { ...lead({ id: 'b' }), upload_attempts: 1 }]);
  let legacyCalls = 0;
  let seen: DataManagerRequest | null = null;
  const summary = await uploadLeadConversions({
    db, account, settings: { conversion_action_resource: RES }, findConversionAction: async () => null, now: NOW,
    transport: async () => { legacyCalls += 1; return { results: [{}] }; },
    channels: dmChannels(async (request) => { seen = request; return { requestId: 'req-1' }; }),
  });
  assert.equal(legacyCalls, 0);
  assert.equal(summary.status, 'ok');
  assert.equal(summary.channel, 'data_manager');
  assert.equal(summary.uploaded, 2);
  assert.equal(seen!.events.length, 2);
  assert.deepEqual(db.inserts[0].rows.map((r) => [r.channel, r.request_id]), [['data_manager', 'req-1'], ['data_manager', 'req-1']]);
  assert.ok(db.updates.some((u) => u.table === 'lead_loop_settings' && u.patch.last_upload_channel === 'data_manager'));
});

test('service: an attempted Data Manager batch stays pinned after an access error', async () => {
  const db = fakeDb([{ ...lead({ id: 'a' }), upload_attempts: 0 }]);
  const summary = await uploadLeadConversions({
    db, account, settings: { conversion_action_resource: RES }, findConversionAction: async () => null, now: NOW,
    transport: async () => ({ results: [{ gclid: 'x' }] }),
    channels: dmChannels(async () => { throw new DataManagerError(403, 'PERMISSION_DENIED', 'insufficient scopes'); }),
  });
  assert.equal(summary.status, 'needs_data_manager_grant');
  assert.equal(summary.channel, undefined);
  assert.equal(summary.uploaded, 0);
  assert.ok(db.updates.some((u) => u.patch.upload_channel === 'data_manager'));
});

test('service: with a grant the blocked legacy API is never reached, and a legacy block seen mid-run falls through to Data Manager when it is second', async () => {
  // preference auto plans [data_manager, legacy]; make Data Manager fail on access, legacy blocked: both closed, grant requested
  const db = fakeDb([{ ...lead({ id: 'a' }), upload_attempts: 0 }]);
  const summary = await uploadLeadConversions({
    db, account, settings: { conversion_action_resource: RES }, findConversionAction: async () => null, now: NOW,
    transport: async () => { throw legacyBlocked(); },
    channels: dmChannels(async () => { throw new DataManagerError(401, 'UNAUTHENTICATED', 'expired'); }),
  });
  assert.equal(summary.status, 'needs_data_manager_grant');
  assert.equal(summary.legacyBlocked, undefined);
  assert.equal(db.updates.some((u) => u.patch.legacy_blocked_at), false);
});

test('service: no grant and legacy refuses with the allowlist error asks for the grant, leads stay waiting, block is recorded', async () => {
  const db = fakeDb([{ ...lead({ id: 'a' }), upload_attempts: 3 }]);
  const summary = await uploadLeadConversions({
    db, account, settings: { conversion_action_resource: RES }, findConversionAction: async () => null, now: NOW,
    transport: async () => { throw legacyBlocked(); },
    channels: dmChannels(async () => ({}), { dataManagerAvailable: false }),
  });
  assert.equal(summary.status, 'needs_data_manager_grant');
  assert.equal(summary.legacyBlocked, true);
  const back = db.updates.find((u) => u.table === 'lead_clicks' && u.patch.upload_status === 'pending')!;
  assert.deepEqual(back.filters.id, ['a']);
  assert.equal('upload_attempts' in back.patch, false);
  assert.ok(db.updates.some((u) => u.table === 'lead_loop_settings' && u.patch.legacy_blocked_at === NOW.toISOString()));
});

test('service: once legacy is known blocked and there is no grant, nothing is claimed at all', async () => {
  const db = fakeDb([{ ...lead({ id: 'a' }), upload_attempts: 0 }]);
  const summary = await uploadLeadConversions({
    db, account, settings: { conversion_action_resource: RES }, findConversionAction: async () => null, now: NOW,
    transport: async () => { throw new Error('must not be called'); },
    channels: dmChannels(async () => ({}), { dataManagerAvailable: false, legacyBlocked: true }),
  });
  assert.equal(summary.status, 'needs_data_manager_grant');
  assert.equal(db.claims, 0);
});

test('service: a revoked Data Manager grant with legacy blocked asks for the grant again', async () => {
  const db = fakeDb([{ ...lead({ id: 'a' }), upload_attempts: 0 }]);
  const summary = await uploadLeadConversions({
    db, account, settings: { conversion_action_resource: RES }, findConversionAction: async () => null, now: NOW,
    transport: async () => { throw new Error('must not be called'); },
    channels: {
      dataManagerAvailable: true,
      makeDataManagerSender: async () => { throw new Error('invalid_grant'); },
      legacyBlocked: true,
    },
  });
  assert.equal(summary.status, 'needs_data_manager_grant');
});

test('service: a batch refused as invalid is isolated row by row, the bad row fails for good and the rest go through', async () => {
  const db = fakeDb([
    { ...lead({ id: 'good1' }), upload_attempts: 0 },
    { ...lead({ id: 'bad', gclid: 'BAD' }), upload_attempts: 0 },
    { ...lead({ id: 'good2' }), upload_attempts: 0 },
  ]);
  const summary = await uploadLeadConversions({
    db, account, settings: { conversion_action_resource: RES }, findConversionAction: async () => null, now: NOW,
    transport: async () => { throw new Error('must not be called'); },
    channels: dmChannels(
      async (request) => {
        if (request.events.some((e) => e.adIdentifiers.gclid === 'BAD')) {
          throw new DataManagerError(400, 'INVALID_ARGUMENT', 'bad click id');
        }
        return { requestId: 'r' };
      },
      { preference: 'data_manager' }
    ),
  });
  assert.equal(summary.status, 'ok');
  assert.equal(summary.uploaded, 2);
  assert.equal(summary.failed, 1);
  assert.ok(db.updates.some((u) => u.patch.upload_status === 'failed' && u.filters.id === 'bad'));
});

test('service: a transient Data Manager failure leaves the leads waiting and burns no attempts', async () => {
  const db = fakeDb([{ ...lead({ id: 'a' }), upload_attempts: 2 }]);
  const summary = await uploadLeadConversions({
    db, account, settings: { conversion_action_resource: RES }, findConversionAction: async () => null, now: NOW,
    transport: async () => ({ results: [{}] }),
    channels: dmChannels(async () => { throw new DataManagerError(503, 'UNAVAILABLE', 'try later'); }, { legacyBlocked: true }),
  });
  assert.equal(summary.status, 'request_failed');
  const back = db.updates.find((u) => u.table === 'lead_clicks' && u.patch.upload_status === 'pending')!;
  assert.equal('upload_attempts' in back.patch, false);
});

test('flag off parity: without channels the summary has no channel keys and the log rows have no channel columns', async () => {
  const db = fakeDb([{ ...lead({ id: 'a' }), upload_attempts: 0 }]);
  const summary = await uploadLeadConversions({
    db, account, settings: { conversion_action_resource: RES }, findConversionAction: async () => null, now: NOW,
    transport: async () => ({ results: [{ gclid: 'x' }] }),
  });
  assert.deepEqual(Object.keys(summary).sort(), ['claimed', 'duplicates', 'failed', 'retried', 'skipped', 'status', 'uploaded']);
  assert.equal('channel' in db.inserts[0].rows[0], false);
  assert.equal(db.updates.some((u) => u.table === 'lead_loop_settings'), false);
  // and a legacy block with no channels is a plain request failure, as before
  const blocked = await uploadLeadConversions({
    db: fakeDb([{ ...lead({ id: 'b' }), upload_attempts: 0 }]), account, settings: { conversion_action_resource: RES },
    findConversionAction: async () => null, now: NOW,
    transport: async () => { throw legacyBlocked(); },
  });
  assert.equal(blocked.status, 'request_failed');
});

test('partial isolation preserves sent rows, retries only unsent rows and never falls through to legacy', async () => {
  const db = fakeDb(['a','b','c'].map((id) => ({...lead({id}),upload_attempts:0})));
  let legacy = 0; let dm=0;
  const summary = await uploadLeadConversions({ db, account, settings:{conversion_action_resource:RES}, findConversionAction:async()=>null, now:NOW,
    transport:async()=>{legacy++;return {};}, channels:dmChannels(async(request)=>{dm++;if(request.events.length>1)throw new DataManagerError(400,'INVALID_ARGUMENT','isolate');if(request.events[0].transactionId==='b')throw new DataManagerError(403,'PERMISSION_DENIED','revoked');return {requestId:'accepted-a'};}) });
  assert.equal(summary.uploaded,1);assert.equal(summary.retried,2);assert.equal(legacy,0);assert.equal(dm,3);
  const uploaded=db.updates.find((u)=>u.patch.upload_status==='uploaded');assert.deepEqual(uploaded?.filters.id,['a']);
  const pending=db.updates.filter((u)=>u.patch.upload_status==='pending');assert.deepEqual(pending.map((u)=>u.filters.id),['b','c']);
});
test('a previously pinned row cannot retry through legacy when the Data Manager grant is absent',async()=>{
  const db=fakeDb([{...lead({id:'pinned'}),upload_attempts:1,upload_channel:'data_manager'}]);let legacy=0;
  const summary=await uploadLeadConversions({db,account,settings:{conversion_action_resource:RES},findConversionAction:async()=>null,now:NOW,transport:async()=>{legacy++;return {};},channels:dmChannels(async()=>({}),{dataManagerAvailable:false})});
  assert.equal(legacy,0);assert.equal(summary.status,'needs_data_manager_grant');
});
