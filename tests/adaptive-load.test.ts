import assert from 'node:assert/strict';
import test from 'node:test';

import { connectJobName } from '../lib/onboarding/connect-progress';
import { loadSetupState, type SetupLoadDeps } from '../lib/setup/load';
import { eqValue, fakeDb, type FakeQuery } from './fixtures/fake-db';
import { clinicAccount, readAgo, signalsRow, untrackedAccount } from './fixtures/adaptive-accounts';
import type { AccountSignals } from '../lib/setup/adaptive/types';

// ---------------------------------------------------------------------------
// loadSetupState with fakes: the read it trusts for the waste number (S7), the
// activity hint for a failed read (B2), and the flag-off guarantee.
// ---------------------------------------------------------------------------

const NOW = new Date('2026-10-14T10:00:00.000Z');
const ENV_ON = { CHAT_FIRST_ENTRY: 'true', ADAPTIVE_ONBOARDING: 'true' };
const ENV_OFF = { CHAT_FIRST_ENTRY: 'true' };

const USER = { id: 'u1', email: 'owner@example.com', user_metadata: { full_name: 'سلطان' } };

const BUSINESS = {
  id: 'biz-1',
  name: 'سلطان',
  sector: null,
  website: null,
  monthly_budget: null,
  primary_goal: null,
  target_regions: [] as string[],
  selected_google_ads_customer_id: null,
};

function accountRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'acc-1',
    customer_id: '1234567890',
    customer_name: 'Smile Clinic',
    manager_id: null,
    status: 'active',
    is_manager: false,
    google_status: 'ENABLED',
    currency_code: 'SAR',
    time_zone: 'Asia/Riyadh',
    last_synced_at: null as string | null,
    ...overrides,
  };
}

const AUDIT = {
  id: 'aud-1',
  health_score: 58,
  findings: [{}, {}, {}],
  estimated_monthly_waste: 1840,
  ran_at: '2026-10-13T07:00:00.000Z',
};

const RECS = [
  {
    id: 'a',
    title: 'قرار a',
    description: 'سبب a',
    severity: 'critical',
    status: 'pending',
    category: 'keywords',
    created_at: '2026-10-13T08:00:00.000Z',
    expected_impact: { metric: 'cost', delta_sar_per_month: 412 },
    action_payload: null,
  },
  { id: 'b', title: 'قرار b', description: 'سبب b', severity: 'medium', status: 'pending', category: 'bidding', created_at: '2026-10-13T08:00:00.000Z', expected_impact: null, action_payload: null },
];

type Setup = {
  subscribed?: boolean;
  env?: Record<string, string | undefined>;
  edit?: boolean;
  signals?: AccountSignals | null;
  /** Hours since the stored read was taken. */
  readHoursAgo?: number;
  account?: ReturnType<typeof accountRow>;
  connectJob?: Record<string, unknown> | null;
  cache?: unknown[];
  memory?: unknown[];
  audit?: typeof AUDIT | null;
  business?: typeof BUSINESS;
};

async function run(setup: Setup = {}) {
  const account = setup.account ?? accountRow();
  const business = setup.business ?? BUSINESS;
  const stored =
    setup.signals === undefined || setup.signals === null ? null : signalsRow(readAgo(setup.signals, NOW, setup.readHoursAgo ?? 1));
  const rls = fakeDb({
    subscriptions: setup.subscribed
      ? [{ plan: 'growth', status: 'active', trial_ends_at: null, current_period_end: '2099-01-01T00:00:00.000Z', created_at: '2026-09-01T00:00:00.000Z' }]
      : [],
    account_access_overrides: [],
    autopilot_settings: [],
    audits: setup.audit === null ? [] : [setup.audit ?? AUDIT],
    recommendations: RECS,
    campaigns_cache: setup.cache ?? [],
    billing_trial_grants: [{ user_id: USER.id }],
  });
  const admin = fakeDb({
    job_runs: (query: FakeQuery) => {
      const name = String(eqValue(query, 'job_name') ?? '');
      if (name.startsWith('google_ads_connect:')) return setup.connectJob ? [setup.connectJob] : [];
      return stored ? [stored] : [];
    },
    business_memory: setup.memory ?? [],
    free_audit_ledger: [],
  });
  const deps: SetupLoadDeps = {
    workspace: {
      business,
      accounts: [account],
      revokedAccounts: [],
      pausedAccounts: [],
      selectedAccount: account,
      selectedCustomerId: account.customer_id,
    } as never,
    admin: admin.client,
    env: setup.env ?? ENV_ON,
    now: NOW,
  };
  const state = await loadSetupState(rls.client, USER, { edit: setup.edit, deps });
  return { state, rls, admin };
}

const finding = (state: Awaited<ReturnType<typeof run>>['state'], id: string) => state.findings.find((row) => row.id === id);

// --- S7a / S7b: the waste number and the finding amounts --------------------

test('S7a: a day later, in edit mode, the waste number stays hidden for a tracking state', async () => {
  // The read is 25 hours old: too old for the questions, still true about the tracking.
  const { state } = await run({ subscribed: true, edit: true, signals: untrackedAccount(), readHoursAgo: 25 });
  assert.equal(state.audit?.estimatedMonthlyWaste, null);
  assert.equal(state.audit?.findingsCount, 3, 'the rest of the audit is untouched');
  assert.equal(state.audit?.healthScore, 58);
});

test('S7b: a subscribed customer in a tracking state sees no amount on any finding', async () => {
  const { state } = await run({ subscribed: true, signals: untrackedAccount(), readHoursAgo: 25 });
  assert.ok(state.findings.length > 0);
  for (const row of state.findings) {
    assert.equal(row.impactAmount, 0, row.id);
    assert.equal(row.impactLabel, null, row.id);
  }
  // Titles and severities are still there.
  assert.equal(finding(state, 'a')?.title, 'قرار a');
  assert.equal(finding(state, 'a')?.severity, 'critical');
});

test('S7: an account whose tracking works keeps the audit number and the amounts', async () => {
  const { state } = await run({ subscribed: true, signals: clinicAccount(), readHoursAgo: 25 });
  assert.equal(state.audit?.estimatedMonthlyWaste, 1840);
  assert.equal(finding(state, 'a')?.impactAmount, 412);
  assert.equal(finding(state, 'a')?.impactLabel, 'توفير متوقع شهرياً');
});

test('S7: no read in the last 30 days leaves everything as it is today', async () => {
  const { state } = await run({ subscribed: true, edit: true, signals: untrackedAccount(), readHoursAgo: 31 * 24 });
  assert.equal(state.audit?.estimatedMonthlyWaste, 1840);
  assert.equal(finding(state, 'a')?.impactAmount, 412);
  const none = await run({ subscribed: true, edit: true, signals: null });
  assert.equal(none.state.audit?.estimatedMonthlyWaste, 1840);
  assert.equal(finding(none.state, 'a')?.impactAmount, 412);
});

test('S7: someone without access never had the amounts, and the tracking state still hides the waste in the plan', async () => {
  const { state } = await run({ subscribed: false, signals: untrackedAccount(), readHoursAgo: 25 });
  assert.equal(state.audit?.estimatedMonthlyWaste, null);
  assert.equal(state.plan?.waste, null);
  for (const row of state.findings) assert.equal(row.impactAmount, 0);
});

// --- B2: a failed read must not let the free audit run on an empty account --

const failedRead = (): AccountSignals => ({ ...clinicAccount(), campaigns: { ok: false, error: 'not_read' } });

test('B2: a failed read of an account the sync saw empty is a new account, and the free audit is not offered', async () => {
  const { state, rls } = await run({
    signals: failedRead(),
    account: accountRow({ last_synced_at: '2026-10-14T06:00:00.000Z' }),
    cache: [],
  });
  assert.equal(state.adaptive?.scenario.state, 'new');
  assert.equal(state.adaptive?.auditAllowed, false);
  const cacheRead = rls.reads().find((query) => query.table === 'campaigns_cache');
  assert.equal(eqValue(cacheRead!, 'account_id'), 'acc-1', 'asked through the customer\'s own client, for this account');
});

test('B2: with no read at all the connect job\'s zero spend says the same', async () => {
  const { state } = await run({
    signals: null,
    connectJob: {
      status: 'success',
      started_at: '2026-10-14T09:00:00.000Z',
      finished_at: '2026-10-14T09:02:00.000Z',
      details: { stage: 'done', spend: { '1234567890': 0 } },
    },
  });
  assert.equal(state.adaptive?.scenario.state, 'new');
  assert.equal(state.adaptive?.auditAllowed, false);
});

test('B2: spend on record keeps the account active and the audit allowed', async () => {
  const spends = await run({
    signals: null,
    connectJob: {
      status: 'success',
      started_at: '2026-10-14T09:00:00.000Z',
      finished_at: '2026-10-14T09:02:00.000Z',
      details: { stage: 'done', spend: { '1234567890': 2400 } },
    },
  });
  assert.equal(spends.state.adaptive?.scenario.state, 'active');
  assert.equal(spends.state.adaptive?.auditAllowed, true);
  assert.equal(spends.state.adaptive?.scenario.kindConfidence, 'none', 'no kind is guessed from a number');

  const cached = await run({
    signals: failedRead(),
    account: accountRow({ last_synced_at: '2026-10-14T06:00:00.000Z' }),
    cache: [{ status: 'ENABLED', metrics_30d: { cost: 900 }, metrics_7d: null }],
  });
  assert.equal(cached.state.adaptive?.scenario.state, 'active');
  assert.equal(cached.state.adaptive?.auditAllowed, true);
});

test('B2: the remaining limit, stated: no read and nothing else known leaves the audit allowed as before', async () => {
  const { state, rls } = await run({ signals: null });
  assert.equal(state.adaptive?.scenario.state, 'active');
  assert.equal(state.adaptive?.auditAllowed, true);
  // An account the sync never ran for is not asked about its cache.
  assert.equal(rls.reads().some((query) => query.table === 'campaigns_cache'), false);
});

test('B2: a good read is not second-guessed by the cache', async () => {
  const { state, rls } = await run({
    signals: clinicAccount(),
    account: accountRow({ last_synced_at: '2026-10-14T06:00:00.000Z' }),
    cache: [],
  });
  assert.equal(state.adaptive?.scenario.state, 'active');
  assert.equal(rls.reads().some((query) => query.table === 'campaigns_cache'), false);
});

// --- the flag-off guarantee (replaces the old regex over load.ts) ------------

test('flag off: nothing adaptive is read, adaptive is null, and the screen has what it always had', async () => {
  const { state, rls, admin } = await run({
    env: ENV_OFF,
    subscribed: true,
    signals: untrackedAccount(),
    readHoursAgo: 25,
    account: accountRow({ last_synced_at: '2026-10-14T06:00:00.000Z' }),
  });
  assert.equal(state.adaptive, null);
  // The tracking read exists, and is ignored: the number and the amounts are the audit's.
  assert.equal(state.audit?.estimatedMonthlyWaste, 1840);
  assert.equal(finding(state, 'a')?.impactAmount, 412);
  assert.equal(admin.reads().some((query) => String(eqValue(query, 'job_name')).startsWith('onboarding_signals:')), false);
  assert.equal(rls.reads().some((query) => query.table === 'campaigns_cache'), false);
});

test('flag off: the plan for someone without access carries no category and keeps the audit decision open', async () => {
  const { state } = await run({ env: ENV_OFF, subscribed: false, signals: untrackedAccount(), readHoursAgo: 25 });
  assert.equal(state.adaptive, null);
  assert.equal(state.plan?.first?.id, 'a');
  assert.equal(state.plan?.waste, 1840);
  assert.equal(JSON.stringify(state.plan).includes('"category"'), false);
  assert.equal(state.stage === 'questions' || state.stage === 'finishing' || state.stage === 'done', true);
});

test('flag on: the same customer has the stage, pending and plan the tree decides, and the plan has no category', async () => {
  const { state } = await run({ subscribed: false, signals: untrackedAccount(), readHoursAgo: 1 });
  assert.equal(state.adaptive?.scenario.state, 'no_tracking');
  assert.equal(state.adaptive?.ending, 'tracking');
  assert.equal(state.plan?.first, null, 'the rules decision took the open slot');
  assert.equal(state.plan?.waste, null);
  assert.equal(JSON.stringify(state).includes('"category"'), false);
});
