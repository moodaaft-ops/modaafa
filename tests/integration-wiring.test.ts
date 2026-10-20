import assert from 'node:assert/strict';
import test from 'node:test';
import { checkGuardrails } from '../lib/ai/optimizer-agent';
import { EMAIL_COPY } from '../lib/lifecycle/copy';
import { EMPTY_FACTS } from '../lib/lifecycle/types';
import { previousMonthWindow, monthlyLimits } from '../lib/loops/monthly';
import { reviewAccount, type MonthlyAccount, type MonthlyDeps } from '../lib/loops/monthly-run';
import { runGuard } from '../lib/guard/run';
import { uploadLeadConversions } from '../lib/lead-loop/upload-service';
import { excludeShadowAccounts } from '../lib/shadow/guard';
import { landingSupportForVerdict } from '../lib/landing-check/evidence';
import type { LandingCheckReport, LandingCheckStore } from '../lib/landing-check/run';
import { fakeDb } from './support/guard-db';
import { NOW as GUARD_NOW } from './support/guard';

// ---------------------------------------------------------------------------
// (1) Monthly money report carries the offer coaching lines
// ---------------------------------------------------------------------------
const MONTH_NOW = new Date('2026-10-01T05:31:00Z');
const account = (): MonthlyAccount => ({
  id: 'acc1',
  customer_id: '1234567890',
  customer_name: 'متجر العطور',
  currency_code: 'SAR',
  business_id: 'b1',
  sector: 'ecommerce',
  primary_goal: 'sales',
  monthly_budget: 4000,
  owner: { id: 'u1', email: 'owner@example.com', name: 'سارة', messages_opt_out: false },
  customer: { query: async () => [] },
});

function monthlyDeps(over: Partial<MonthlyDeps> = {}) {
  const seen = { sentCoaching: undefined as string[] | undefined, coachingCalls: 0, totals: 0 };
  const deps: MonthlyDeps = {
    readTotals: async () => (seen.totals++, { cost: 3200, conversions: 40, conversion_value: 14000, campaigns: [] }),
    loadEconomics: async () => null,
    readNgram: async () => null,
    readCompetition: async () => ({ source: 'unavailable', findings: [], share_trend: null, summary_ar: null, fallback_reason: null }),
    readQuality: async () => [],
    loadOutcomes: async () => [],
    loadMerchant: async () => null,
    hasReport: async () => false,
    saveReport: async () => 'saved',
    callModel: async () => null,
    send: async (_a, _w, _m, _p, coaching) => ((seen.sentCoaching = coaching), { status: 'skipped', reason: 'not_approved' } as any),
    loadCoaching: async () => (seen.coachingCalls++, ['إعلانك يشتغل بس الرد بطيء. الخطوة: رد خلال دقايق']),
    modelName: () => 'm',
    ...over,
  };
  return { deps, seen };
}
const runMonth = (deps: MonthlyDeps, env: Record<string, string>) =>
  reviewAccount({ account: account(), window: previousMonthWindow(MONTH_NOW), now: MONTH_NOW, limits: monthlyLimits({}), deps, env });

test('monthly report: coaching lines go to the mail only when OFFER_COACHING_ENABLED is on', async () => {
  const on = monthlyDeps();
  await runMonth(on.deps, { MONTHLY_REVIEW_ENABLED: 'true', OFFER_COACHING_ENABLED: 'true' });
  assert.deepEqual(on.seen.sentCoaching, ['إعلانك يشتغل بس الرد بطيء. الخطوة: رد خلال دقايق']);

  const off = monthlyDeps();
  await runMonth(off.deps, { MONTHLY_REVIEW_ENABLED: 'true' });
  assert.equal(off.seen.coachingCalls, 0);
  assert.deepEqual(off.seen.sentCoaching, []);
});

test('monthly report copy: coaching block appears only when lines exist, and the old mail is unchanged without them', () => {
  const monthly = { month: '2026-09', monthNameAr: 'سبتمبر', moneyLines: ['صرفت 3200 ريال'], planLines: ['خطة'] };
  const build = (extra: object) => EMAIL_COPY.monthly_report.build({ ...EMPTY_FACTS, monthly: { ...monthly, ...extra } } as any)!;
  const without = JSON.stringify(build({}).blocks);
  assert.ok(!without.includes('ملاحظات على العرض والرد'));
  assert.equal(JSON.stringify(build({ coachingLines: [] }).blocks), without);
  assert.ok(JSON.stringify(build({ coachingLines: ['سطر'] }).blocks).includes('ملاحظات على العرض والرد'));
});

// ---------------------------------------------------------------------------
// (2) Landing tag evidence supports the tracking verdict, never changes it
// ---------------------------------------------------------------------------
const report = (googleTag: 'visible' | 'not_visible'): LandingCheckReport => ({
  version: 1,
  checkedAt: '2026-10-17T00:00:00Z',
  pages: [],
  findings: [],
  tracking: { googleTag, pagesChecked: 1, line_ar: 'سطر' },
});
const storeOf = (r: LandingCheckReport): LandingCheckStore => ({ latest: async () => ({ checked_at: r.checkedAt, report: r }), save: async () => {} });

test('landing evidence: flag off touches nothing; on adds a supporting note only for tracking verdicts', async () => {
  let reads = 0;
  const countingStore = () => ((reads += 1), storeOf(report('not_visible')));
  const common = { accountId: 'a', now: new Date('2026-10-19T00:00:00Z') };
  assert.equal(await landingSupportForVerdict({ ...common, enabled: false, store: countingStore, verdict: 'suspect' }), null);
  assert.equal(reads, 0);

  const suspect = await landingSupportForVerdict({ ...common, enabled: true, store: () => storeOf(report('not_visible')), verdict: 'suspect' });
  assert.equal(suspect?.supporting_only, true);
  assert.equal(suspect?.checked_days_ago, 2);
  assert.ok(suspect?.note_ar);
  const healthy = await landingSupportForVerdict({ ...common, enabled: true, store: () => storeOf(report('not_visible')), verdict: 'healthy' });
  assert.equal(healthy?.note_ar, undefined);
  const visible = await landingSupportForVerdict({ ...common, enabled: true, store: () => storeOf(report('visible')), verdict: 'suspect' });
  assert.equal(visible?.note_ar, undefined);
  assert.equal(await landingSupportForVerdict({ ...common, enabled: true, store: () => null, verdict: 'suspect' }), null);
  assert.equal(
    await landingSupportForVerdict({ ...common, enabled: true, store: () => ({ latest: async () => { throw new Error('x'); }, save: async () => {} }), verdict: 'suspect' }),
    null
  );
});

// ---------------------------------------------------------------------------
// (3) Shadow accounts are excluded everywhere
// ---------------------------------------------------------------------------
test('excludeShadowAccounts: flag off returns the same rows without a read; on drops shadow ones; unreadable drops all', async () => {
  const db = fakeDb({ shadow_accounts: [{ account_id: 's1' }] });
  const rows = [{ id: 's1' }, { id: 'r1' }];
  assert.equal(await excludeShadowAccounts(db, rows, false), rows);
  assert.deepEqual(db.reads, []);
  assert.deepEqual(await excludeShadowAccounts(db, rows, true), [{ id: 'r1' }]);
  const broken = { from: () => ({ select: () => ({ in: async () => ({ data: null, error: { code: '500' } }) }) }) };
  assert.deepEqual(await excludeShadowAccounts(broken, rows, true), []);
});

test('guard run: a shadow account is not checked and its owner is not mailed', async () => {
  const mkAccount = (id: string) => ({
    id, business_id: 'biz-1', customer_id: '123-456-7890', customer_name: 'x', manager_id: null, currency_code: 'SAR',
    time_zone: 'Asia/Riyadh', refresh_token_encrypted: 'x', google_status: 'ENABLED', status: 'active', guard_checked_at: null, is_manager: false,
  });
  const make = () =>
    fakeDb({
      businesses: [{ id: 'biz-1', user_id: 'u-1' }],
      users: [{ id: 'u-1', email: 'o@example.com', name: 'س', messages_opt_out: false }],
      google_ads_accounts: [mkAccount('shadow-1')],
      shadow_accounts: [{ account_id: 'shadow-1' }],
    });
  let opened = 0;
  const sent: unknown[] = [];
  const store = { loadExisting: async () => [], apply: async () => {}, listNotifiable: async () => [], markNotified: async () => {} };
  const deps = (env: Record<string, string>) => ({
    supabase: make(), env, now: GUARD_NOW, store,
    openCustomer: () => ((opened += 1), { query: async () => [] }),
    billableBusinessIds: async () => ['biz-1'], sendTemplate: async (i: unknown) => (sent.push(i), { status: 'sent' as const }),
  });
  const withShadow = await runGuard(deps({ GUARD_ENABLED: 'true', SHADOW_MODE_ENABLED: 'true' }) as any, {});
  assert.equal(withShadow.accounts.considered, 0);
  assert.equal(opened, 0);
  assert.equal(sent.length, 0);
  const flagOff = await runGuard(deps({ GUARD_ENABLED: 'true' }) as any, {});
  assert.equal(flagOff.accounts.considered, 1);
  assert.equal(opened, 1);
});

test('monthly review: a shadow account gets no report and no mail', async () => {
  const { deps, seen } = monthlyDeps({ isShadow: async () => true });
  const out = await runMonth(deps, { MONTHLY_REVIEW_ENABLED: 'true', SHADOW_MODE_ENABLED: 'true' });
  assert.deepEqual(out, { account_id: 'acc1', status: 'skipped', reason: 'shadow_account' });
  assert.equal(seen.totals, 0);
  // Flag off: the shadow lookup is never consulted.
  let asked = 0;
  const off = monthlyDeps({ isShadow: async () => (asked++, true) });
  const outOff = await runMonth(off.deps, { MONTHLY_REVIEW_ENABLED: 'true' });
  assert.equal(asked, 0);
  assert.equal(outOff.status, 'reported');
});

test('lead-loop upload: a shadow account uploads nothing and touches no lead row', async () => {
  const saved = process.env.SHADOW_MODE_ENABLED;
  process.env.SHADOW_MODE_ENABLED = 'true';
  try {
    const touched: string[] = [];
    const db: any = {
      from: (table: string) => {
        touched.push(table);
        const b: any = { select: () => b, eq: () => b, maybeSingle: async () => ({ data: { account_id: 'acc' }, error: null }) };
        return b;
      },
      rpc: async () => (touched.push('rpc'), { data: [], error: null }),
    };
    const summary = await uploadLeadConversions({
      db,
      account: { id: 'acc', customerId: '1234567890' },
      settings: { conversion_action_resource: 'customers/1/conversionActions/2' },
      transport: async () => { throw new Error('must not send'); },
      findConversionAction: async () => null,
    });
    assert.equal(summary.status, 'nothing_to_upload');
    assert.deepEqual(touched, ['shadow_accounts']);
  } finally {
    if (saved === undefined) delete process.env.SHADOW_MODE_ENABLED;
    else process.env.SHADOW_MODE_ENABLED = saved;
  }
});

test('campaign launch: checkGuardrails refuses launch_campaign on a shadow account (fails closed)', async () => {
  const saved = { ...process.env };
  try {
    process.env.SHADOW_MODE_ENABLED = 'true';
    process.env.CAMPAIGN_LAUNCH_ENABLED = 'true';
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const rejected: string[] = [];
    const out = await checkGuardrails(
      { type: 'launch_campaign', target_id: 'x', params: {}, reason_ar: 'x', reason_en: 'x', expected_impact: { metric: 'm', delta_pct: 0, delta_sar_per_month: 0 } } as any,
      'acc',
      {} as any,
      { snapshot: {} as any, onReject: (r: any) => rejected.push(r.code) }
    );
    assert.equal(out, null);
    assert.deepEqual(rejected, ['shadow_account']);
  } finally {
    process.env = saved;
  }
});
