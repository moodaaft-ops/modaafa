import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { checkGuardrails } from '../lib/ai/optimizer-agent';
import { isShadowAccount, loadShadowAccountIds } from '../lib/shadow/guard';
import { shadowModeEnabled } from '../lib/shadow/flag';
import { recordShadowDecisions, saveShadowReview } from '../lib/shadow/store';
import {
  categoryForActionType,
  weekStartUtc,
  weeklyAgreement,
  type ShadowDecisionRow,
  type ShadowReviewRow,
} from '../lib/shadow/summary';

function adminWith(result: { data?: any; error?: any } | (() => never)) {
  return () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            if (typeof result === 'function') return result();
            return { data: result.data ?? null, error: result.error ?? null };
          },
        }),
      }),
    }),
  });
}

test('flag is off unless exactly true', () => {
  assert.equal(shadowModeEnabled({} as any), false);
  assert.equal(shadowModeEnabled({ SHADOW_MODE_ENABLED: '1' } as any), false);
  assert.equal(shadowModeEnabled({ SHADOW_MODE_ENABLED: 'true' } as any), true);
});

test('flag off: nothing is read and no account is shadow', async () => {
  let touched = false;
  const result = await isShadowAccount('a', { enabled: false, admin: () => ((touched = true), null) });
  assert.equal(result, false);
  assert.equal(touched, false);
});

test('flag on: a marked account is shadow, an unmarked one is not', async () => {
  assert.equal(await isShadowAccount('a', { enabled: true, admin: adminWith({ data: { account_id: 'a' } }) }), true);
  assert.equal(await isShadowAccount('a', { enabled: true, admin: adminWith({ data: null }) }), false);
});

test('flag on: an unreadable state fails closed, a table that is not there yet does not', async () => {
  assert.equal(await isShadowAccount('a', { enabled: true, admin: adminWith({ error: { code: '500', message: 'x' } }) }), true);
  assert.equal(await isShadowAccount('a', { enabled: true, admin: adminWith({ error: { code: '42P01' } }) }), false);
  assert.equal(await isShadowAccount('a', { enabled: true, admin: adminWith({ error: { code: 'PGRST205' } }) }), false);
  assert.equal(await isShadowAccount('a', { enabled: true, admin: adminWith(() => { throw new Error('boom'); }) }), true);
  assert.equal(await isShadowAccount('a', { enabled: true, admin: () => null }), true);
});

test('checkGuardrails refuses every action type on a shadow account (state unreadable here, so it fails closed)', async () => {
  const saved = { ...process.env };
  try {
    process.env.SHADOW_MODE_ENABLED = 'true';
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const rejected: string[] = [];
    for (const type of ['add_negative_keyword', 'pause_keyword', 'adjust_budget', 'adjust_bid', 'pause_ad', 'add_keyword']) {
      const out = await checkGuardrails(
        { type, target_id: 'x', params: {}, reason_ar: 'x', reason_en: 'x', expected_impact: { metric: 'm', delta_pct: 0, delta_sar_per_month: 0 } } as any,
        'acc',
        {} as any,
        { snapshot: {} as any, onReject: (r: any) => rejected.push(r.code) }
      );
      assert.equal(out, null, type);
    }
    assert.deepEqual([...new Set(rejected)], ['shadow_account']);
  } finally {
    process.env = saved;
  }
});

test('shadow cards go to shadow_decisions only, never executable, never to recommendations', async () => {
  const writes: Array<{ table: string; rows: any[] }> = [];
  const admin = {
    from: (table: string) => ({
      insert: async (rows: any[]) => (writes.push({ table, rows }), { error: null }),
    }),
  };
  const out = await recordShadowDecisions({
    admin,
    accountId: 'acc',
    jobRunId: 'job',
    cards: [
      { type: 'add_negative_keyword', target_id: 'c', params: { keyword_text: 'x' }, reason_ar: 'سبب', confidence: 0.97 },
      { type: 'adjust_budget', target_id: 'b', params: { delta_pct: 10 }, reason_ar: 'سبب' },
    ],
  });
  assert.equal(out.stored, 2);
  assert.deepEqual([...new Set(writes.map((w) => w.table))], ['shadow_decisions']);
  for (const row of writes[0].rows) assert.equal(row.executable, false);
  assert.deepEqual(writes[0].rows.map((r) => r.category), ['negatives', 'budget']);
});

test('the migration makes executable = true impossible, and no role but the service role has access', () => {
  const sql = readFileSync(new URL('../db/migrations/20261020_trust_shadow_mode.sql', import.meta.url), 'utf8');
  assert.match(sql, /executable BOOLEAN NOT NULL DEFAULT FALSE CHECK \(executable = FALSE\)/);
  for (const table of ['shadow_accounts', 'shadow_decisions', 'shadow_reviews']) {
    assert.match(sql, new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`));
    assert.match(sql, new RegExp(`REVOKE ALL ON TABLE public\\.${table} FROM anon, authenticated`));
  }
  assert.doesNotMatch(sql, /GRANT/);
  assert.doesNotMatch(sql, /CREATE POLICY/);
  assert.doesNotMatch(sql, /REFERENCES public\.recommendations|INSERT INTO public\.recommendations/);
});

test('in the optimizer cron the shadow branch comes before the policy gate and before any queueing', () => {
  const src = readFileSync(new URL('../app/api/cron/optimize/route.ts', import.meta.url), 'utf8');
  const shadow = src.indexOf('shadowAccountIds?.has(account.id)');
  assert.ok(shadow > 0);
  for (const marker of ['evaluateAutopilotPolicy({ ...policyContext })', 'queueOptimizerRecommendation({', 'executeAutopilotAction({']) {
    assert.ok(src.indexOf(marker) > shadow, marker);
  }
});

test('review: a verdict needs a decision of the same account; a miss stands alone', async () => {
  const rows: any[] = [];
  const admin = {
    from: (table: string) => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: 'd1', account_id: 'acc', category: 'budget' }, error: null }) }) }),
      upsert: async (row: any) => (rows.push({ table, row }), { error: null }),
      insert: async (row: any) => (rows.push({ table, row }), { error: null }),
    }),
  };
  await assert.rejects(saveShadowReview({ admin, accountId: 'acc', decisionId: null, verdict: 'right', reviewerId: 'op' }), /decision_required/);
  await assert.rejects(saveShadowReview({ admin, accountId: 'other', decisionId: 'd1', verdict: 'wrong', reviewerId: 'op' }), /decision_not_found/);
  await saveShadowReview({ admin, accountId: 'acc', decisionId: 'd1', verdict: 'wrong', note: ' غلط ', reviewerId: 'op' });
  assert.equal(rows[0].row.category, 'budget');
  assert.equal(rows[0].row.note, 'غلط');
  await saveShadowReview({ admin, accountId: 'acc', decisionId: 'ignored', verdict: 'missed', category: 'tracking', note: 'x', reviewerId: 'op' });
  assert.equal(rows[1].row.decision_id, null);
  assert.equal(rows[1].row.category, 'tracking');
});

test('loadShadowAccountIds returns the marked ones and tolerates a missing table', async () => {
  const ok = { from: () => ({ select: () => ({ in: async () => ({ data: [{ account_id: 'a' }], error: null }) }) }) };
  assert.deepEqual([...(await loadShadowAccountIds(ok, ['a', 'b']))], ['a']);
  const missing = { from: () => ({ select: () => ({ in: async () => ({ data: null, error: { code: '42P01', message: 'x' } }) }) }) };
  assert.equal((await loadShadowAccountIds(missing, ['a'])).size, 0);
});

// -- weekly agreement -------------------------------------------------------------

const MON = new Date('2026-10-19T00:00:00Z');
const dec = (id: string, category: string, day: string): ShadowDecisionRow => ({ id, account_id: 'acc', category, created_at: `2026-10-${day}T09:00:00Z` });
const rev = (id: string, decision_id: string | null, verdict: any, category: string, day: string, at = '10'): ShadowReviewRow => ({ id, account_id: 'acc', decision_id, verdict, category, created_at: `2026-10-${day}T${at}:00:00Z` });

test('week start is Monday UTC', () => {
  assert.equal(weekStartUtc(new Date('2026-10-22T15:00:00Z')).toISOString(), '2026-10-19T00:00:00.000Z');
  assert.equal(weekStartUtc(new Date('2026-10-25T23:59:00Z')).toISOString(), '2026-10-19T00:00:00.000Z');
  assert.equal(weekStartUtc(new Date('2026-10-26T00:00:00Z')).toISOString(), '2026-10-26T00:00:00.000Z');
});

test('agreement is right over right+wrong of the reviewed ones; misses are grouped', () => {
  const decisions = [dec('1', 'negatives', '19'), dec('2', 'negatives', '20'), dec('3', 'budget', '21'), dec('4', 'keywords', '22'), dec('old', 'budget', '12')];
  const reviews = [
    rev('r1', '1', 'right', 'negatives', '20'),
    rev('r2', '2', 'right', 'negatives', '20'),
    rev('r3', '3', 'wrong', 'budget', '22'),
    rev('rold', 'old', 'wrong', 'budget', '22'),
    rev('m1', null, 'missed', 'tracking', '23'),
    rev('m2', null, 'missed', 'tracking', '24'),
    rev('m3', null, 'missed', 'ads', '24'),
    rev('mold', null, 'missed', 'ads', '12'),
  ];
  const s = weeklyAgreement(decisions, reviews, MON);
  assert.equal(s.decisions, 4);
  assert.equal(s.reviewed, 3);
  assert.equal(s.right, 2);
  assert.equal(s.wrong, 1);
  assert.equal(s.agreePct, 67);
  assert.equal(s.coveragePct, 75);
  assert.equal(s.missed, 3);
  assert.deepEqual(s.missesBy, [{ category: 'tracking', count: 2 }, { category: 'ads', count: 1 }]);
  assert.deepEqual(s.wrongBy, [{ category: 'budget', count: 1 }]);
});

test('the latest verdict on a decision wins, and an empty week has no percentages', () => {
  const s = weeklyAgreement([dec('1', 'budget', '20')], [rev('a', '1', 'wrong', 'budget', '20', '08'), rev('b', '1', 'right', 'budget', '21', '08')], MON);
  assert.equal(s.right, 1);
  assert.equal(s.wrong, 0);
  const empty = weeklyAgreement([], [], MON);
  assert.equal(empty.agreePct, null);
  assert.equal(empty.coveragePct, null);
  assert.deepEqual(empty.missesBy, []);
});

test('action types map to categories, unknown ones to other', () => {
  assert.equal(categoryForActionType('add_negative_keyword'), 'negatives');
  assert.equal(categoryForActionType('adjust_bid'), 'bidding');
  assert.equal(categoryForActionType('something_new'), 'other');
});
