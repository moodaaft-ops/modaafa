import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildClickConversion,
  buildUploadClickConversionsRequest,
  extractPartialFailures,
  formatConversionDateTime,
  interpretUploadResponse,
  pickClickId,
  UPLOAD_MAX_BATCH,
} from '@/lib/google-ads/click-conversions';
import { uploadLeadConversions, CLICK_MAX_AGE_DAYS } from '@/lib/lead-loop/upload-service';
import { buildDataExclusionCreate, dataExclusionName, validateDataExclusionParams } from '@/lib/measurement/data-exclusion';
import { findTrackingGaps, totalsByDay } from '@/lib/measurement/tracking-gaps';
import { reviewConversionGoals, LEAD_CONVERSION_ACTION_NAME } from '@/lib/measurement/goals';
import { buildExecutableAction } from '@/lib/ai/executable-action';

const RES = 'customers/1234567890/conversionActions/555';
const lead = (over: Record<string, unknown> = {}) => ({
  id: '11111111-1111-4111-8111-111111111111',
  gclid: 'Cj0KCQiAabcdef123456',
  clicked_at: '2026-10-18T10:00:00Z',
  marked_at: '2026-10-19T09:30:00Z',
  value_sar: 450,
  ...over,
});

test('click conversion payload: one click id, order id = lead id, account-zone time, SAR value', () => {
  const payload = buildClickConversion(lead({ gbraid: 'ignored' }), { conversionAction: RES, timeZone: 'Asia/Riyadh' })!;
  assert.equal(payload.gclid, 'Cj0KCQiAabcdef123456');
  assert.equal(payload.gbraid, undefined);
  assert.equal(payload.orderId, lead().id);
  assert.equal(payload.conversionDateTime, '2026-10-19 12:30:00+03:00');
  assert.equal(payload.conversionValue, 450);
  assert.equal(payload.currencyCode, 'SAR');
  assert.equal(buildClickConversion(lead({ value_sar: null }), { conversionAction: RES })!.conversionValue, undefined);
  assert.equal(buildClickConversion(lead({ gclid: null }), { conversionAction: RES }), null);
  assert.deepEqual(pickClickId({ gclid: null, gbraid: null, wbraid: 'W' }), { field: 'wbraid', value: 'W' });
  // never before the click
  const early = buildClickConversion(lead({ marked_at: '2026-10-18T09:00:00Z' }), { conversionAction: RES, timeZone: 'UTC' })!;
  assert.equal(early.conversionDateTime, '2026-10-18 10:00:01+00:00');
  assert.equal(formatConversionDateTime(new Date('2026-01-01T22:30:00Z'), 'America/New_York'), '2026-01-01 17:30:00-05:00');
});

test('upload request: partial failure always on, validateOnly optional, batch capped, unbuildable leads skipped', () => {
  const leads = Array.from({ length: UPLOAD_MAX_BATCH + 5 }, (_, i) => lead({ id: `id-${i}` }));
  const built = buildUploadClickConversionsRequest([...leads, lead({ id: 'nope', gclid: null })], { conversionAction: RES, validateOnly: true });
  assert.equal(built.body.partialFailure, true);
  assert.equal(built.body.validateOnly, true);
  assert.equal(built.body.conversions.length, UPLOAD_MAX_BATCH);
  assert.equal(built.leadIds.length, UPLOAD_MAX_BATCH);
  const small = buildUploadClickConversionsRequest([lead(), lead({ id: 'x', gclid: null, gbraid: null })], { conversionAction: RES });
  assert.deepEqual(small.skipped, [{ leadId: 'x', reason: 'no_click_id' }]);
  assert.equal('validateOnly' in small.body, false);
});

function failure(index: number | null, code: string) {
  return {
    details: [
      {
        errors: [
          {
            errorCode: { conversionUploadError: code },
            message: code,
            location: index === null ? undefined : { fieldPathElements: [{ fieldName: 'conversions', index }] },
          },
        ],
      },
    ],
  };
}

test('partial failure handling: per-row outcomes, duplicates count as done, silence is not success', () => {
  const ids = ['a', 'b', 'c', 'd'];
  const response = {
    results: [{ gclid: 'x' }, {}, { gclid: 'y' }, {}],
    partialFailureError: {
      details: [
        ...failure(1, 'DUPLICATE_ORDER_ID').details,
        ...failure(3, 'EXPIRED_EVENT').details,
      ],
    },
  };
  const out = interpretUploadResponse(response, ids);
  assert.deepEqual(out.map((o) => o.outcome), ['uploaded', 'duplicate', 'uploaded', 'failed']);
  assert.equal(extractPartialFailures(response.partialFailureError).length, 2);

  const transient = interpretUploadResponse({ results: [{}, {}], partialFailureError: failure(0, 'TOO_RECENT_CONVERSION_ACTION') }, ['a', 'b']);
  assert.equal(transient[0].outcome, 'retry');
  assert.equal(transient[1].outcome, 'retry'); // no result and no error: not claimed as success

  const general = interpretUploadResponse({ results: [], partialFailureError: failure(null, 'INTERNAL_ERROR') }, ['a']);
  assert.equal(general[0].outcome, 'retry');
  assert.equal(interpretUploadResponse(null, ['a'])[0].outcome, 'retry');
  assert.equal(interpretUploadResponse(null, ['a'], { validateOnly: true })[0].outcome, 'uploaded');
  assert.equal(interpretUploadResponse({ results: [{ a: 1 }] }, ['a'])[0].outcome, 'uploaded');
});

/** Minimal chainable fake of the supabase client for the upload service. */
function fakeDb(claimed: any[]) {
  const updates: Array<{ table: string; patch: any; filters: Record<string, unknown> }> = [];
  const inserts: Array<{ table: string; rows: any[] }> = [];
  let claims = 0;
  const db = {
    updates,
    inserts,
    rpc: async () => {
      claims += 1;
      // a second claim finds nothing: the SQL function marks rows 'uploading'
      return { data: claims === 1 ? claimed : [], error: null };
    },
    from(table: string) {
      return {
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
  return db;
}

const account = { id: 'acc', customerId: '1234567890', timeZone: 'Asia/Riyadh' };
const NOW = new Date('2026-10-19T12:00:00Z');

test('upload service: marks uploaded, retry and failed rows separately and logs each attempt', async () => {
  const db = fakeDb([
    { ...lead({ id: 'ok' }), upload_attempts: 0 },
    { ...lead({ id: 'dup' }), upload_attempts: 1 },
    { ...lead({ id: 'late' }), upload_attempts: 0 },
    { ...lead({ id: 'bad' }), upload_attempts: 0 },
  ]);
  const summary = await uploadLeadConversions({
    db,
    account,
    settings: { conversion_action_resource: RES },
    findConversionAction: async () => null,
    now: NOW,
    transport: async () => ({
      results: [{ gclid: 'x' }, {}, {}, {}],
      partialFailureError: { details: [...failure(1, 'DUPLICATE_ORDER_ID').details, ...failure(2, 'TOO_RECENT_CLICK').details, ...failure(3, 'EXPIRED_EVENT').details] },
    }),
  });
  assert.deepEqual(
    { s: summary.status, u: summary.uploaded, d: summary.duplicates, r: summary.retried, f: summary.failed },
    { s: 'ok', u: 1, d: 1, r: 1, f: 1 }
  );
  const done = db.updates.find((u) => u.patch.upload_status === 'uploaded')!;
  assert.deepEqual(done.filters.id, ['ok', 'dup']);
  assert.ok(db.updates.some((u) => u.patch.upload_status === 'pending' && u.filters.id === 'late' && u.patch.upload_attempts === 1));
  assert.ok(db.updates.some((u) => u.patch.upload_status === 'failed' && u.filters.id === 'bad'));
  assert.equal(db.inserts[0].rows.length, 4);
});

test('upload service is idempotent: the second run claims nothing and sends nothing', async () => {
  const db = fakeDb([{ ...lead(), upload_attempts: 0 }]);
  let sent = 0;
  const run = () =>
    uploadLeadConversions({
      db,
      account,
      settings: { conversion_action_resource: RES },
      findConversionAction: async () => null,
      now: NOW,
      transport: async () => {
        sent += 1;
        return { results: [{ gclid: 'x' }] };
      },
    });
  assert.equal((await run()).uploaded, 1);
  assert.equal((await run()).status, 'nothing_to_upload');
  assert.equal(sent, 1);
});

test('upload service: request failure leaves leads waiting, expired clicks never leave, missing action stops early', async () => {
  const db = fakeDb([{ ...lead({ id: 'a' }), upload_attempts: 2 }, { ...lead({ id: 'old', clicked_at: new Date(NOW.getTime() - (CLICK_MAX_AGE_DAYS + 2) * 86400000).toISOString() }), upload_attempts: 0 }]);
  const summary = await uploadLeadConversions({
    db, account, settings: { conversion_action_resource: RES }, findConversionAction: async () => null, now: NOW,
    transport: async () => { throw new Error('boom'); },
  });
  assert.equal(summary.status, 'request_failed');
  assert.equal(summary.failed, 1);
  const back = db.updates.find((u) => u.patch.upload_status === 'pending')!;
  assert.deepEqual(back.filters.id, ['a']);
  assert.equal('upload_attempts' in back.patch, false); // not the lead's fault: attempts not burned

  const none = await uploadLeadConversions({
    db: fakeDb([]), account, settings: { conversion_action_resource: null }, findConversionAction: async () => null, now: NOW,
    transport: async () => { throw new Error('must not be called'); },
  });
  assert.equal(none.status, 'no_conversion_action');
});

const START = '2026-10-01 00:00:00';
const END = '2026-10-05 23:59:59';
const exclusion = {
  name: dataExclusionName('2026-10-01', '2026-10-05'),
  scope: 'CHANNEL',
  advertising_channel_types: ['SEARCH'],
  start_date_time: START,
  end_date_time: END,
};

test('data exclusion: builder shape, validation and the start-in-the-past rule', () => {
  const ok = validateDataExclusionParams(exclusion, { now: new Date('2026-10-19T00:00:00Z'), timeZone: 'Asia/Riyadh' });
  assert.ok(ok.ok);
  if (ok.ok) {
    const body = buildDataExclusionCreate(ok.value);
    assert.equal(body.scope, 'CHANNEL');
    assert.deepEqual((body as Record<string, unknown>).advertising_channel_types, ['SEARCH']);
    assert.equal('campaigns' in body, false);
    assert.equal(body.start_date_time, START);
  }
  const bad = (over: Record<string, unknown>, options = {}) => {
    const r = validateDataExclusionParams({ ...exclusion, ...over }, options);
    return r.ok ? 'ok' : r.code;
  };
  assert.equal(bad({ name: '' }), 'name_invalid');
  assert.equal(bad({ scope: 'ACCOUNT' }), 'scope_invalid');
  assert.equal(bad({ advertising_channel_types: ['NOPE'] }), 'channels_invalid');
  assert.equal(bad({ scope: 'CAMPAIGN', campaigns: ['customers/1/campaigns/2'], advertising_channel_types: undefined }, { customerId: '999' }), 'campaigns_invalid');
  assert.equal(bad({ start_date_time: '2026-10-01' }), 'date_format_invalid');
  assert.equal(bad({ end_date_time: '2026-09-01 00:00:00' }), 'end_before_start');
  assert.equal(bad({ end_date_time: '2026-11-30 00:00:00' }), 'window_too_long');
  assert.equal(bad({ start_date_time: '2026-10-25 00:00:00', end_date_time: '2026-10-26 00:00:00' }, { now: new Date('2026-10-19T00:00:00Z') }), 'start_not_in_past');
});

test('tracking gaps: a resolved silent stretch with traffic is a gap; an ongoing one is not proposed; low traffic is ignored', () => {
  const day = (n: number, conversions: number, clicks = 60) => ({ date: `2026-09-${String(n).padStart(2, '0')}`, conversions, clicks });
  const days = Array.from({ length: 28 }, (_, i) => day(i + 1, i >= 10 && i < 15 ? 0 : 4));
  const found = findTrackingGaps(days);
  assert.equal(found.gaps.length, 1);
  assert.equal(found.gaps[0].days, 5);
  assert.equal(found.ongoing, false);

  const ongoing = findTrackingGaps(Array.from({ length: 28 }, (_, i) => day(i + 1, i >= 22 ? 0 : 4)));
  assert.equal(ongoing.gaps.length, 0);
  assert.equal(ongoing.ongoing, true);

  const quiet = findTrackingGaps(Array.from({ length: 28 }, (_, i) => day(i + 1, i >= 10 && i < 15 ? 0 : 4, i >= 10 && i < 15 ? 3 : 60)));
  assert.equal(quiet.gaps.length, 0);

  const totals = totalsByDay([{ date: '2026-10-18', conversions: 2 }], [{ date: '2026-10-18', clicks: 9 }], '2026-10-19', 3);
  assert.deepEqual(totals.map((d) => d.date), ['2026-10-16', '2026-10-17', '2026-10-18']);
  assert.deepEqual(totals[2], { date: '2026-10-18', conversions: 2, clicks: 9 });
});

const action = (over: Record<string, unknown>) => ({
  name: 'x', status: 'ENABLED', type: 'WEBPAGE', category: 'PURCHASE', origin: 'WEBSITE',
  primaryForGoal: true, includeInConversionsMetric: true, conversions30d: 20, ...over,
}) as any;

test('goals review: WhatsApp click as primary, double primaries, enhanced conversions, lead action ladder', () => {
  const findings = reviewConversionGoals({
    actions: [
      action({ name: 'نقرة واتساب', type: 'CLICK_TO_CALL', category: 'CONTACT' }),
      action({ name: 'WhatsApp click', type: 'WEBPAGE', category: 'CONTACT' }),
      action({ name: 'Purchase', type: 'WEBPAGE' }),
      action({ name: 'Purchase GA4', type: 'GOOGLE_ANALYTICS_4_PURCHASE' }),
    ],
    goals: null,
    tracking: { enhancedConversionsForLeads: false, acceptedCustomerDataTerms: true },
    leadLoopOn: true,
  });
  const codes = findings.map((f) => f.code);
  assert.ok(codes.includes('whatsapp_click_primary'));
  assert.ok(codes.includes('multiple_primaries_same_category'));
  assert.ok(codes.includes('enhanced_conversions_off'));
  assert.ok(codes.includes('lead_action_missing'));

  const off = reviewConversionGoals({ actions: [action({ name: 'WhatsApp click', category: 'CONTACT' })], goals: null, tracking: null, leadLoopOn: false });
  assert.ok(!off.some((f) => f.code === 'lead_action_missing'));
  assert.ok(!JSON.stringify(off).includes(LEAD_CONVERSION_ACTION_NAME));

  const ready = reviewConversionGoals({
    actions: [action({ name: 'WhatsApp click', category: 'CONTACT' }), action({ name: LEAD_CONVERSION_ACTION_NAME, type: 'UPLOAD_CLICKS', category: 'CONTACT', primaryForGoal: false, includeInConversionsMetric: false, conversions30d: 18 })],
    goals: null, tracking: null, leadLoopOn: true,
  });
  assert.ok(ready.some((f) => f.code === 'lead_action_ready_for_primary'));
});

test('user-facing measurement copy has no dashes or latin commas inside arabic', () => {
  const findings = reviewConversionGoals({
    actions: [action({ name: 'WhatsApp click', category: 'CONTACT' })],
    goals: [{ category: 'CONTACT', origin: 'WEBSITE', biddable: false }],
    tracking: { enhancedConversionsForLeads: false, acceptedCustomerDataTerms: false },
    leadLoopOn: true,
  });
  const text = JSON.stringify(findings.map((f) => [f.title_ar, f.reason_ar, f.steps_ar]));
  assert.ok(!/[—–]/.test(text));
  assert.ok(!/[؀-ۿ],\s/.test(text));
  assert.ok(!text.includes('ليس مجرد'));
});

test('executable action gating: measurement operations exist only with the flag on and only for the owning account', () => {
  const payload = { operation: 'add_data_exclusion', target_id: 'customers/1234567890', params: exclusion };
  const prior = process.env.LEAD_LOOP_ENABLED;
  try {
    delete process.env.LEAD_LOOP_ENABLED;
    assert.equal(buildExecutableAction(payload as any, { title: 't' }, '1234567890'), null);
    process.env.LEAD_LOOP_ENABLED = 'true';
    assert.ok(buildExecutableAction(payload as any, { title: 't' }, '1234567890'));
    assert.equal(buildExecutableAction(payload as any, { title: 't' }, '999'), null);
    assert.equal(buildExecutableAction({ ...payload, target_id: 'customers/999' } as any, { title: 't' }, '1234567890'), null);
    assert.equal(buildExecutableAction({ ...payload, params: { ...exclusion, scope: 'X' } } as any, { title: 't' }, '1234567890'), null);
  } finally {
    if (prior === undefined) delete process.env.LEAD_LOOP_ENABLED;
    else process.env.LEAD_LOOP_ENABLED = prior;
  }
});
