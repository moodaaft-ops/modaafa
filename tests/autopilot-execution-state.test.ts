import assert from 'node:assert/strict';
import test from 'node:test';
import { assertAutopilotExecutionAuthorized } from '../lib/autopilot/execution-state';
import { refreshAutopilotEvidence } from '../lib/autopilot/live-evidence';
import { DEFAULT_AUTOPILOT_SETTINGS, type AutopilotCandidate } from '../lib/autopilot/types';

const action: AutopilotCandidate = {
  type: 'add_negative_keyword', target_id: 'customers/123/campaigns/456',
  params: { campaign_resource: 'customers/123/campaigns/456', keyword_text: 'وظائف', match_type: 'EXACT' },
  reason_ar: 'بحث غير مرتبط', reason_en: 'Unrelated search', confidence: 0.98,
  expected_impact: { metric: 'wasted_spend', delta_pct: -5, delta_sar_per_month: 10 },
  evidence: { clicks: 10, conversions: 0, cost_micros: 1000000, window_days: 30, relevance: 'clearly_irrelevant' },
};
const settings = { ...DEFAULT_AUTOPILOT_SETTINGS, account_id: 'account-1', mode: 'conservative', terms_accepted_at: '2026-08-25T00:00:00Z' };

function database(overrides: Record<string, any> = {}) {
  const rows: Record<string, any> = {
    autopilot_settings: { data: settings },
    google_ads_accounts: { data: { status: 'active', is_manager: false } },
    recommendations: { data: [] }, ...overrides,
  };
  return { from(table: string) {
    assert.ok(table in rows);
    return {
      select() { return this; },
      eq(key: string, value: string) {
        if (key === 'account_id' || (key === 'id' && table === 'google_ads_accounts')) assert.equal(value, 'account-1');
        return this;
      },
      in() { return this; }, or() { return this; }, order() { return this; },
      range(start: number, end: number) { return Promise.resolve({ ...rows[table], data: rows[table].data?.slice(start, end + 1) }); },
      maybeSingle() { return Promise.resolve(rows[table]); },
    };
  } };
}

function authorize(db = database(), extra = {}) {
  return assertAutopilotExecutionAuthorized({
    supabase: db, accountId: 'account-1', action, expectedConfigVersion: 1,
    trackingStatus: 'healthy', globalExecutionEnabled: true,
    now: new Date('2026-09-07T10:00:00Z'), ...extra,
  });
}

test('unchanged consent and verified empty history permit a safe candidate', async () => {
  assert.equal((await authorize()).outcome, 'execute');
});

for (const change of [{ mode: 'off' }, { config_version: 2 }, { terms_accepted_at: null }, { paused_at: '2026-09-07' }]) {
  test(`consent re-read blocks ${JSON.stringify(change)}`, async () => {
    await assert.rejects(authorize(database({ autopilot_settings: { data: { ...settings, ...change } } })), /Autopilot/);
  });
}

test('an interrupted mutation freezes all targets even without a decision log', async () => {
  await assert.rejects(authorize(database({ recommendations: { data: [
    { id: 'old-1', status: 'executing', execution_started_at: '2026-08-01' },
  ] } })), /reconciliation/);
});

test('applied reservations enforce daily limits when the decision ledger lost every entry', async () => {
  const data = Array.from({ length: 3 }, (_, i) => ({
    id: String(i), status: 'applied', execution_started_at: '2026-09-07T01:00:00Z',
    action_payload: { operation: action.type, params: { ...action.params, keyword_text: `term-${i}` } },
  }));
  await assert.rejects(authorize(database({ recommendations: { data } })), /daily_limit_reached/);
});

test('history failure and account revocation fail closed', async () => {
  await assert.rejects(authorize(database({ recommendations: { error: { message: 'down' } } })), /history/);
  await assert.rejects(authorize(database({ google_ads_accounts: { data: { status: 'revoked', is_manager: false } } })), /eligible/);
});

test('the final boundary requires its own executing reservation to still exist', async () => {
  await assert.rejects(authorize(database(), { currentRecommendationId: 'current' }), /missing/);
  const verdict = await authorize(database({ recommendations: { data: [
    { id: 'current', status: 'executing' },
  ] } }), { currentRecommendationId: 'current' });
  assert.equal(verdict.outcome, 'execute');
});

function evidenceRow(conversions: number, clicks = 10) {
  return { campaign: { resourceName: action.params.campaign_resource }, searchTermView: { searchTerm: 'وظائف' },
    metrics: { clicks, costMicros: 1000000, conversions } };
}

test('live evidence includes conversions in other ad groups before a campaign-wide negative', async () => {
  const grounded = await refreshAutopilotEvidence({ query: async (query: string) => {
    assert.doesNotMatch(query, /metrics\.conversions\s*=|metrics\.clicks\s*>|LIMIT/);
    return [evidenceRow(0), evidenceRow(1, 2)];
  } }, action);
  assert.equal(grounded.evidence.conversions, 1);
  assert.equal(grounded.evidence.clicks, 12);
  await assert.rejects(authorize(database(), { action: grounded }), /insufficient_evidence/);
});

test('empty, malformed or failed live evidence cannot authorize execution', async () => {
  for (const rows of [[], [evidenceRow(NaN)], [{ ...evidenceRow(0), metrics: {} }]]) {
    await assert.rejects(refreshAutopilotEvidence({ query: async () => rows }, action), /evidence/);
  }
  await assert.rejects(refreshAutopilotEvidence({ query: async () => { throw new Error('timeout'); } }, action), /timeout/);
});
