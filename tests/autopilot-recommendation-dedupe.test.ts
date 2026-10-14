import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUTOPILOT_FAILED_RETRY_COOLDOWN_MS,
  MAX_PENDING_ADD_KEYWORDS_PER_AD_GROUP,
  blocksAutopilotFingerprint,
  dedupeTermKey,
  findPendingDuplicate,
  loadActiveRecommendationPool,
  rememberRecommendation,
  renewStalePendingRecommendation,
  type ActiveRecommendationRow,
} from '../lib/autopilot/recommendation-dedupe';

const NOW = Date.parse('2026-08-25T12:00:00.000Z');

test('active, applied and user-dismissed recommendations permanently block duplicates', () => {
  for (const status of ['pending', 'approved', 'executing', 'applied', 'dismissed']) {
    assert.equal(
      blocksAutopilotFingerprint(
        { id: status, status, created_at: '2025-01-01T00:00:00.000Z' },
        NOW
      ),
      true,
      status
    );
  }
});

test('a recent technical failure blocks an immediate autopilot retry', () => {
  assert.equal(
    blocksAutopilotFingerprint(
      {
        id: 'failed-recently',
        status: 'failed',
        created_at: new Date(NOW - AUTOPILOT_FAILED_RETRY_COOLDOWN_MS + 1_000).toISOString(),
      },
      NOW
    ),
    true
  );
});

test('a technical failure becomes retryable after the quiet period', () => {
  assert.equal(
    blocksAutopilotFingerprint(
      {
        id: 'failed-yesterday',
        status: 'failed',
        created_at: new Date(NOW - AUTOPILOT_FAILED_RETRY_COOLDOWN_MS).toISOString(),
      },
      NOW
    ),
    false
  );
});

test('malformed failure timestamps fail closed', () => {
  assert.equal(
    blocksAutopilotFingerprint(
      { id: 'failed-unknown', status: 'failed', created_at: 'not-a-date' },
      NOW
    ),
    true
  );
});

test('missing and unrelated terminal rows do not block a fingerprint', () => {
  assert.equal(blocksAutopilotFingerprint(null, NOW), false);
  assert.equal(
    blocksAutopilotFingerprint(
      { id: 'ignored', status: 'superseded', created_at: '2026-08-25T00:00:00.000Z' },
      NOW
    ),
    false
  );
});

// ---------------------------------------------------------------------------
// Dedupe by target (queue time)
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(NOW - days * DAY).toISOString();
const AD_GROUP = 'customers/123/adGroups/55';
const OTHER_AD_GROUP = 'customers/123/adGroups/56';
const CAMPAIGN = 'customers/123/campaigns/789';
const OTHER_CAMPAIGN = 'customers/123/campaigns/790';
const BUDGET = 'customers/123/campaignBudgets/456';

function pending(
  id: string,
  operation: string,
  params: Record<string, unknown>,
  extra: Partial<ActiveRecommendationRow> & { source?: string } = {}
): ActiveRecommendationRow {
  const { source, ...rest } = extra;
  return {
    id,
    status: 'pending',
    created_at: daysAgo(1),
    action_payload: { operation, params, source: source ?? 'optimizer_cron' },
    ...rest,
  };
}

const addKeyword = (keyword_text: string, match_type = 'EXACT', ad_group_resource = AD_GROUP) => ({
  type: 'add_keyword',
  target_id: ad_group_resource,
  params: { ad_group_resource, keyword_text, match_type },
});

test('the same keyword in the same ad group is a duplicate under any match type', () => {
  const pool = [pending('p1', 'add_keyword', { ad_group_resource: AD_GROUP, keyword_text: 'عيادة اسنان', match_type: 'EXACT' })];
  const verdict = findPendingDuplicate(pool, addKeyword('عيادة اسنان', 'PHRASE'), NOW);
  assert.deepEqual(verdict, {
    skip: true,
    code: 'duplicate_keyword_pending',
    reason_ar: 'عندك توصية معلّقة بنفس الكلمة في نفس المجموعة الإعلانية، فما كررناها.',
    recommendation_id: 'p1',
  });
  // Another ad group, or another keyword, is a different decision.
  assert.deepEqual(findPendingDuplicate(pool, addKeyword('عيادة اسنان', 'EXACT', OTHER_AD_GROUP), NOW), { skip: false });
  assert.deepEqual(findPendingDuplicate(pool, addKeyword('تقويم اسنان'), NOW), { skip: false });
});

test('Arabic spelling variants, tashkeel, tatweel and spacing do not make two keywords different', () => {
  assert.equal(dedupeTermKey('أسنان'), dedupeTermKey('اسنان'));
  assert.equal(dedupeTermKey('إزالة'), dedupeTermKey('ازاله'));
  assert.equal(dedupeTermKey('عيـــادة'), dedupeTermKey('عياده'));
  assert.equal(dedupeTermKey('مُستشفى'), dedupeTermKey('مستشفي'));
  assert.equal(dedupeTermKey('  Dental   Clinic '), dedupeTermKey('dental clinic'));

  const pool = [pending('p1', 'add_keyword', { ad_group_resource: AD_GROUP, keyword_text: 'مركز أسنان', match_type: 'PHRASE' })];
  for (const variant of ['مركز اسنان', 'مَركز  أسنان', 'مـركز إسنان']) {
    assert.equal(findPendingDuplicate(pool, addKeyword(variant, 'EXACT'), NOW).skip, true, variant);
  }
});

test('at most 3 pending keyword additions wait in one ad group', () => {
  assert.equal(MAX_PENDING_ADD_KEYWORDS_PER_AD_GROUP, 3);
  const pool = ['أ', 'ب', 'ج'].map((word, index) =>
    pending(`p${index}`, 'add_keyword', { ad_group_resource: AD_GROUP, keyword_text: `كلمة ${word}`, match_type: 'EXACT' })
  );
  const capped = findPendingDuplicate(pool, addKeyword('كلمة د'), NOW);
  assert.equal(capped.skip, true);
  assert.equal(capped.skip && capped.code, 'ad_group_keyword_cap');
  // Two waiting leave room for the third.
  assert.deepEqual(findPendingDuplicate(pool.slice(0, 2), addKeyword('كلمة د'), NOW), { skip: false });
  // Another ad group has its own three.
  assert.deepEqual(findPendingDuplicate(pool, addKeyword('كلمة د', 'EXACT', OTHER_AD_GROUP), NOW), { skip: false });
});

test('eight pending additions in one ad group (the live case) stop at the cap', () => {
  const pool: ActiveRecommendationRow[] = [];
  let queued = 0;
  for (let index = 0; index < 8; index += 1) {
    const action = addKeyword(`عبارة رقم ${index}`);
    if (findPendingDuplicate(pool, action, NOW).skip) continue;
    rememberRecommendation(pool, action, { id: `rec-${index}`, nowMs: NOW });
    queued += 1;
  }
  assert.equal(queued, 3);
  assert.equal(pool.length, 3);
});

test('a stale pending optimizer row neither blocks nor counts toward the cap', () => {
  const stale = pending('old', 'add_keyword', { ad_group_resource: AD_GROUP, keyword_text: 'عيادة اسنان', match_type: 'EXACT' }, { created_at: daysAgo(30) });
  assert.deepEqual(findPendingDuplicate([stale], addKeyword('عيادة اسنان', 'PHRASE'), NOW), { skip: false });

  const staleThree = ['أ', 'ب', 'ج'].map((word, index) =>
    pending(`s${index}`, 'add_keyword', { ad_group_resource: AD_GROUP, keyword_text: `كلمة ${word}`, match_type: 'EXACT' }, { created_at: daysAgo(40) })
  );
  assert.deepEqual(findPendingDuplicate(staleThree, addKeyword('كلمة د'), NOW), { skip: false });

  // 13 days old is still a current decision.
  const recent = pending('recent', 'add_keyword', { ad_group_resource: AD_GROUP, keyword_text: 'عيادة اسنان', match_type: 'EXACT' }, { created_at: daysAgo(13) });
  assert.equal(findPendingDuplicate([recent], addKeyword('عيادة اسنان'), NOW).skip, true);
});

test('an approved or executing row still counts as already on the table', () => {
  for (const status of ['approved', 'executing']) {
    const row = pending('p', 'add_keyword', { ad_group_resource: AD_GROUP, keyword_text: 'عيادة اسنان', match_type: 'EXACT' }, { status, created_at: daysAgo(30) });
    assert.equal(findPendingDuplicate([row], addKeyword('عيادة اسنان'), NOW).skip, true, status);
  }
  // Applied, dismissed and failed rows are history, not a card waiting.
  for (const status of ['applied', 'dismissed', 'failed']) {
    const row = pending('p', 'add_keyword', { ad_group_resource: AD_GROUP, keyword_text: 'عيادة اسنان', match_type: 'EXACT' }, { status });
    assert.equal(findPendingDuplicate([row], addKeyword('عيادة اسنان'), NOW).skip, false, status);
  }
});

test('a negative keyword is a duplicate in the same campaign whatever the match type, and a pending batch counts', () => {
  const negative = (keyword_text: string, campaign_resource = CAMPAIGN, match_type = 'EXACT') => ({
    type: 'add_negative_keyword',
    target_id: campaign_resource,
    params: { campaign_resource, keyword_text, match_type },
  });
  const pool = [pending('n1', 'add_negative_keyword', { campaign_resource: CAMPAIGN, keyword_text: 'مجاني', match_type: 'PHRASE' })];
  assert.equal(findPendingDuplicate(pool, negative('مجاني', CAMPAIGN, 'EXACT'), NOW).skip, true);
  assert.equal(findPendingDuplicate(pool, negative('مَجاني', CAMPAIGN), NOW).skip, true);
  assert.deepEqual(findPendingDuplicate(pool, negative('مجاني', OTHER_CAMPAIGN), NOW), { skip: false });
  assert.deepEqual(findPendingDuplicate(pool, negative('وظائف'), NOW), { skip: false });

  const batch = [pending('b1', 'add_negative_keywords_batch', { campaign_resource: CAMPAIGN, match_type: 'EXACT', keywords: ['وظائف', 'مجانا'] })];
  const hit = findPendingDuplicate(batch, negative('وظائف'), NOW);
  assert.equal(hit.skip && hit.code, 'duplicate_negative_pending');
  assert.deepEqual(findPendingDuplicate(batch, negative('وظائف', OTHER_CAMPAIGN), NOW), { skip: false });

  // Negatives have no per-campaign cap.
  const many = Array.from({ length: 6 }, (_, index) =>
    pending(`m${index}`, 'add_negative_keyword', { campaign_resource: CAMPAIGN, keyword_text: `مصطلح ${index}`, match_type: 'EXACT' })
  );
  assert.deepEqual(findPendingDuplicate(many, negative('مصطلح جديد'), NOW), { skip: false });
});

test('a budget change is a duplicate on the same budget, a bid change on the same ad group', () => {
  const budget = { type: 'adjust_budget', target_id: BUDGET, params: { budget_resource: BUDGET, delta_pct: 10 } };
  const bid = { type: 'adjust_bid', target_id: AD_GROUP, params: { ad_group_resource: AD_GROUP, target_roas: 6 } };
  const pool = [
    pending('b', 'adjust_budget', { budget_resource: BUDGET, delta_pct: 15 }),
    pending('g', 'adjust_bid', { ad_group_resource: AD_GROUP, target_roas: 5.5 }),
  ];
  const budgetHit = findPendingDuplicate(pool, budget, NOW);
  assert.equal(budgetHit.skip && budgetHit.code, 'duplicate_budget_pending');
  assert.equal(budgetHit.skip && budgetHit.recommendation_id, 'b');
  const bidHit = findPendingDuplicate(pool, bid, NOW);
  assert.equal(bidHit.skip && bidHit.code, 'duplicate_bid_pending');
  assert.deepEqual(
    findPendingDuplicate(pool, { ...budget, params: { budget_resource: 'customers/123/campaignBudgets/999' } }, NOW),
    { skip: false }
  );
  assert.deepEqual(
    findPendingDuplicate(pool, { ...bid, params: { ad_group_resource: OTHER_AD_GROUP, target_roas: 6 } }, NOW),
    { skip: false }
  );
  // A stale pending budget card from three weeks ago is not a lock.
  const old = [pending('old', 'adjust_budget', { budget_resource: BUDGET }, { created_at: daysAgo(21) })];
  assert.deepEqual(findPendingDuplicate(old, budget, NOW), { skip: false });
});

test('operations without a dedupe rule pass, and an unreadable pool skips only the covered ones', () => {
  assert.deepEqual(findPendingDuplicate(null, { type: 'pause_keyword', params: {} }, NOW), { skip: false });
  assert.deepEqual(findPendingDuplicate([], { type: 'pause_ad', params: {} }, NOW), { skip: false });
  for (const action of [addKeyword('عيادة'), { type: 'adjust_budget', params: { budget_resource: BUDGET } }]) {
    const verdict = findPendingDuplicate(null, action, NOW);
    assert.equal(verdict.skip && verdict.code, 'pending_unreadable');
  }
  // Missing targets are left to the other gates.
  assert.deepEqual(findPendingDuplicate([], { type: 'add_keyword', params: {} }, NOW), { skip: false });
});

test('a row this run just queued is remembered, and its placeholder id never leaks as a recommendation id', () => {
  const pool: ActiveRecommendationRow[] = [];
  rememberRecommendation(pool, addKeyword('عيادة اسنان'), { id: null, nowMs: NOW });
  const verdict = findPendingDuplicate(pool, addKeyword('عيادة اسنان', 'PHRASE'), NOW);
  assert.equal(verdict.skip && verdict.code, 'duplicate_keyword_pending');
  assert.equal(verdict.skip && verdict.recommendation_id, null);
  // No pool, nothing to remember into.
  rememberRecommendation(null, addKeyword('x'), { id: 'x' });
});

function fakeDb(handlers: { select?: { data: any; error: any }; update?: { data: any; error: any } }) {
  const calls: Array<[string, unknown[]]> = [];
  const make = (result: { data: any; error: any }) => {
    const builder: any = {};
    for (const method of ['select', 'eq', 'in', 'order', 'limit', 'update']) {
      builder[method] = (...args: unknown[]) => {
        calls.push([method, args]);
        return builder;
      };
    }
    builder.maybeSingle = async () => result;
    builder.then = (resolve: (value: any) => unknown) => Promise.resolve(result).then(resolve);
    return builder;
  };
  const client = {
    calls,
    from(table: string) {
      calls.push(['from', [table]]);
      const builder = make(handlers.select ?? { data: null, error: null });
      const update = builder.update;
      builder.update = (...args: unknown[]) => {
        update(...args);
        return make(handlers.update ?? { data: [], error: null });
      };
      return builder;
    },
  };
  return client;
}

test('the pool is read for the account with the three active statuses, newest first', async () => {
  const db = fakeDb({ select: { data: [{ id: 'a', status: 'pending' }], error: null } });
  const pool = await loadActiveRecommendationPool(db, 'account-1');
  assert.deepEqual(pool, [{ id: 'a', status: 'pending' }]);
  assert.ok(db.calls.some(([m, a]) => m === 'eq' && a[0] === 'account_id' && a[1] === 'account-1'));
  assert.ok(db.calls.some(([m, a]) => m === 'in' && a[0] === 'status' && JSON.stringify(a[1]) === JSON.stringify(['pending', 'approved', 'executing'])));
  assert.equal(await loadActiveRecommendationPool(fakeDb({ select: { data: null, error: { message: 'down' } } }), 'account-1'), null);
});

const FIELDS = {
  category: 'keywords',
  severity: 'growth',
  title: 'جديد',
  description: 'نص جديد',
  expected_impact: { metric: 'conversions' },
  action_payload: { operation: 'add_keyword', params: {}, source: 'optimizer_cron' },
};

test('a pending optimizer row older than 14 days is renewed in place, still pending, with its old date kept in the payload', async () => {
  const written: any[] = [];
  const db: any = fakeDb({
    select: { data: { id: 'old', status: 'pending', created_at: daysAgo(30), action_payload: { source: 'optimizer_cron' } }, error: null },
    update: { data: [{ id: 'old' }], error: null },
  });
  const original = db.from.bind(db);
  db.from = (table: string) => {
    const builder = original(table);
    const update = builder.update;
    builder.update = (values: any) => {
      written.push(values);
      return update(values);
    };
    return builder;
  };
  assert.equal(await renewStalePendingRecommendation(db, 'old', FIELDS, NOW), true);
  assert.equal(written.length, 1);
  assert.equal(written[0].created_at, new Date(NOW).toISOString());
  assert.equal(written[0].title, 'جديد');
  assert.equal(written[0].action_payload.renewed_from_created_at, daysAgo(30));
  assert.equal('status' in written[0], false, 'the status is never rewritten');
  assert.ok((db.calls as Array<[string, unknown[]]>).some(([m, a]) => m === 'eq' && a[0] === 'status' && a[1] === 'pending'), 'the update only touches a row that is still pending');
});

test('a fresh, approved or non-optimizer row is never renewed, and a lost race changes nothing', async () => {
  const cases = [
    { status: 'pending', created_at: daysAgo(2), action_payload: { source: 'optimizer_cron' } },
    { status: 'approved', created_at: daysAgo(30), action_payload: { source: 'optimizer_cron' } },
    { status: 'pending', created_at: daysAgo(30), action_payload: { source: 'jarvis_chat' } },
  ];
  for (const current of cases) {
    const db = fakeDb({ select: { data: { id: 'x', ...current }, error: null }, update: { data: [{ id: 'x' }], error: null } });
    assert.equal(await renewStalePendingRecommendation(db, 'x', FIELDS, NOW), false, JSON.stringify(current));
    assert.equal(db.calls.some(([m]) => m === 'update'), false);
  }
  const raced = fakeDb({
    select: { data: { id: 'x', status: 'pending', created_at: daysAgo(30), action_payload: { source: 'optimizer_cron' } }, error: null },
    update: { data: [], error: null },
  });
  assert.equal(await renewStalePendingRecommendation(raced, 'x', FIELDS, NOW), false);
  assert.equal(await renewStalePendingRecommendation(fakeDb({ select: { data: null, error: { message: 'down' } } }), 'x', FIELDS, NOW), false);
});
