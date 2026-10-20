import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { NextRequest } from 'next/server';

import {
  buildExecutableAction,
  cleanNegativeKeywordBatch,
} from '../lib/ai/executable-action';
import {
  negativeWouldBlock,
  normalizeKeywordText,
  prepareActionForExecution,
} from '../lib/ai/execution-preflight';
import {
  finalizeMeasurement,
  finalizeRollbackPayload,
  resultResourceNames,
} from '../lib/ai/execution-result';
import {
  checkGuardrails,
  executeAction,
  executeRollback,
  type OptimizerAction,
} from '../lib/ai/optimizer-agent';
import { rollbackResourcesScoped } from '../lib/ai/rollback-scope';
import { measureObservedImpacts } from '../lib/ai/impact';
import { OPERATION_LABELS_AR } from '../lib/ai/operation-labels';
import { planApply } from '../lib/chat-first/orchestrator';
import type { ChatState } from '../lib/chat-first/contracts';
import { AUTOPILOT_SAFE_ACTIONS, DEFAULT_AUTOPILOT_SETTINGS } from '../lib/autopilot/types';
import { evaluateAutopilotPolicy } from '../lib/autopilot/policy';
import { normalizeAutopilotSettings } from '../lib/autopilot/settings';
import { executeAutopilotAction } from '../lib/autopilot/executor';
import { createRecommendationActionHandler } from '../lib/recommendations/action-handler';

const CID = '1234567890';
const CAMPAIGN = `customers/${CID}/campaigns/555`;
const rec = {
  title: 'توصية',
  description: 'وصف',
  expected_impact: { metric: 'cost', delta_pct: -5, delta_sar_per_month: 100 },
};

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type CustomerOptions = {
  campaignStatus?: string | number | null;
  budgetMicros?: number;
  existingNegatives?: Array<{ text: string; matchType: string }>;
  convertingTerms?: string[];
  enabledKeywords?: string[];
  createResult?: unknown;
};

/** Google Ads customer double: answers GAQL by FROM clause, records mutates. */
function fakeCustomer(options: CustomerOptions = {}) {
  const queries: string[] = [];
  const calls: Array<{ service: string; op: string; items: unknown[]; options?: unknown }> = [];
  const record = (service: string, op: string) => async (items: unknown[], opts?: unknown) => {
    calls.push({ service, op, items, options: opts });
    if (service === 'campaignCriteria' && op === 'create') {
      return (
        options.createResult ?? {
          results: (items as unknown[]).map((_, i) => ({ resourceName: `customers/${CID}/campaignCriteria/555~${900 + i}` })),
        }
      );
    }
    return { results: [{ resourceName: 'ok' }] };
  };
  const customer = {
    queries,
    calls,
    async query(gaql: string) {
      queries.push(gaql);
      if (gaql.includes('metrics.cost_micros')) {
        return [{ metrics: { costMicros: '40000000', clicks: 20, conversions: 1, conversionsValue: 50 } }];
      }
      if (gaql.includes('FROM campaign_criterion')) {
        return (options.existingNegatives ?? []).map((n) => ({
          campaignCriterion: { keyword: { text: n.text, matchType: n.matchType } },
        }));
      }
      if (gaql.includes('FROM search_term_view')) {
        return (options.convertingTerms ?? []).map((term) => ({
          searchTermView: { searchTerm: term },
          metrics: { conversions: 1 },
        }));
      }
      if (gaql.includes('FROM keyword_view')) {
        return (options.enabledKeywords ?? []).map((text) => ({
          adGroupCriterion: { keyword: { text, matchType: 'PHRASE' } },
        }));
      }
      if (gaql.includes('FROM campaign')) {
        if (options.campaignStatus === null) return [];
        return [
          {
            campaign: { resourceName: CAMPAIGN, status: options.campaignStatus ?? 'ENABLED' },
            campaignBudget: { amountMicros: String(options.budgetMicros ?? 50_000_000) },
          },
        ];
      }
      return [];
    },
    campaigns: { update: record('campaigns', 'update') },
    campaignCriteria: { create: record('campaignCriteria', 'create'), remove: record('campaignCriteria', 'remove') },
    adGroupCriteria: { update: record('adGroupCriteria', 'update'), create: record('adGroupCriteria', 'create'), remove: record('adGroupCriteria', 'remove') },
    campaignBudgets: { update: record('campaignBudgets', 'update') },
    adGroups: { update: record('adGroups', 'update') },
    adGroupAds: { update: record('adGroupAds', 'update') },
  };
  return customer;
}

/** PostgREST-shaped chainable stub; `respond` decides each terminal result. */
function fakeDb(respond: (op: DbOp) => { data: any; error: any }) {
  const ops: DbOp[] = [];
  return {
    ops,
    from(table: string) {
      const op: DbOp = { table, kind: 'select', values: null, filters: [] };
      const run = () => {
        ops.push(op);
        return Promise.resolve(respond(op));
      };
      const builder: any = {
        select: () => builder,
        insert: (values: any) => ((op.kind = 'insert'), (op.values = values), builder),
        update: (values: any) => ((op.kind = 'update'), (op.values = values), builder),
        eq: (k: string, v: unknown) => (op.filters.push(['eq', k, v]), builder),
        in: (k: string, v: unknown) => (op.filters.push(['in', k, v]), builder),
        is: (k: string, v: unknown) => (op.filters.push(['is', k, v]), builder),
        gte: () => builder,
        lte: () => builder,
        or: () => builder,
        order: () => builder,
        limit: () => builder,
        single: run,
        maybeSingle: run,
        then: (resolve: any, reject: any) => run().then(resolve, reject),
      };
      return builder;
    },
  };
}
type DbOp = { table: string; kind: 'select' | 'insert' | 'update'; values: any; filters: Array<[string, string, unknown]> };

function batchPayload(keywords: unknown, overrides: Record<string, unknown> = {}) {
  return {
    operation: 'add_negative_keywords_batch',
    target_id: '',
    params: { campaign_resource: CAMPAIGN, match_type: 'PHRASE', keywords, ...overrides },
  };
}

function action(type: OptimizerAction['type'], targetId: string, params: Record<string, unknown> = {}): OptimizerAction {
  return {
    type,
    target_id: targetId,
    params,
    reason_ar: 'اختبار',
    reason_en: 'test',
    expected_impact: { metric: 'cost', delta_pct: 0, delta_sar_per_month: 0 },
  };
}

// ---------------------------------------------------------------------------
// buildExecutableAction
// ---------------------------------------------------------------------------

test('pause/enable campaign payloads execute only for a campaign of the selected account', () => {
  for (const operation of ['pause_campaign', 'enable_campaign']) {
    assert.ok(buildExecutableAction({ operation, target_id: CAMPAIGN }, rec, CID));
    assert.equal(buildExecutableAction({ operation, target_id: 'customers/999/campaigns/555' }, rec, CID), null);
    assert.equal(buildExecutableAction({ operation, target_id: `customers/${CID}/adGroups/1` }, rec, CID), null);
    assert.equal(buildExecutableAction({ operation, target_id: '' }, rec, CID), null);
  }
});

test('a negative batch is accepted, canonicalised and addressed by its campaign', () => {
  const built = buildExecutableAction(batchPayload(['  وظائف   مجانية ', 'وظائف مجانية', 'Free JOBS', 'free jobs']), rec, CID);
  assert.ok(built);
  assert.equal(built.type, 'add_negative_keywords_batch');
  assert.equal(built.target_id, CAMPAIGN);
  assert.deepEqual(built.params.keywords, ['وظائف مجانية', 'Free JOBS']);
});

test('a negative batch is rejected for foreign accounts, bad sizes, BROAD and bad text', () => {
  const ok = ['a'];
  assert.equal(buildExecutableAction(batchPayload(ok, { campaign_resource: 'customers/999/campaigns/555' }), rec, CID), null);
  assert.equal(buildExecutableAction(batchPayload(ok, { campaign_resource: '' }), rec, CID), null);
  assert.equal(buildExecutableAction(batchPayload(Array.from({ length: 11 }, (_, i) => `k${i}`)), rec, CID), null);
  assert.ok(buildExecutableAction(batchPayload(Array.from({ length: 10 }, (_, i) => `k${i}`)), rec, CID));
  assert.equal(buildExecutableAction(batchPayload([]), rec, CID), null);
  assert.equal(buildExecutableAction(batchPayload(['   ']), rec, CID), null);
  assert.equal(buildExecutableAction(batchPayload('not-a-list'), rec, CID), null);
  assert.equal(buildExecutableAction(batchPayload(['ok', 42]), rec, CID), null);
  assert.equal(buildExecutableAction(batchPayload(ok, { match_type: 'BROAD' }), rec, CID), null);
  assert.equal(buildExecutableAction(batchPayload(ok, { match_type: '' }), rec, CID), null);
  assert.equal(buildExecutableAction(batchPayload(['x'.repeat(81)]), rec, CID), null);
  assert.ok(buildExecutableAction(batchPayload(['x'.repeat(80)]), rec, CID));
  assert.equal(buildExecutableAction(batchPayload(['a b c d e f g h i j k']), rec, CID), null);
  assert.ok(buildExecutableAction(batchPayload(['a b c d e f g h i j']), rec, CID));
});

test('batch cleaning de-duplicates case-insensitively and fails whole on any bad entry', () => {
  assert.deepEqual(cleanNegativeKeywordBatch(['Shoes', 'SHOES', ' shoes ']), ['Shoes']);
  assert.equal(cleanNegativeKeywordBatch(['ok', '']), null);
  assert.equal(cleanNegativeKeywordBatch(null), null);
});

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

test('pause_campaign preflight requires a live ENABLED campaign and captures rollback + metrics', async () => {
  const customer = fakeCustomer({ campaignStatus: 'ENABLED' });
  const prepared = await prepareActionForExecution(action('pause_campaign', CAMPAIGN), customer);
  assert.deepEqual(prepared.rollbackPayload, {
    reversible: true,
    action_type: 'restore_campaign_status',
    campaign_resource: CAMPAIGN,
    status: 'ENABLED',
  });
  assert.equal(prepared.measurement?.level, 'campaign');
  assert.equal(prepared.measurement?.resource, CAMPAIGN);
  assert.deepEqual(prepared.measurement?.before, { cost: 40, clicks: 20, conversions: 1, conversion_value: 50 });
  assert.ok(customer.queries.some((q) => /FROM campaign\s+WHERE campaign\.resource_name/.test(q) && q.includes('LAST_7_DAYS')));

  await assert.rejects(
    prepareActionForExecution(action('pause_campaign', CAMPAIGN), fakeCustomer({ campaignStatus: 'PAUSED' })),
    /not ENABLED/
  );
  await assert.rejects(
    prepareActionForExecution(action('pause_campaign', CAMPAIGN), fakeCustomer({ campaignStatus: null })),
    /Unable to read campaign status/
  );
});

test('enable_campaign preflight requires PAUSED and a positive budget', async () => {
  const prepared = await prepareActionForExecution(
    action('enable_campaign', CAMPAIGN),
    fakeCustomer({ campaignStatus: 'PAUSED', budgetMicros: 30_000_000 })
  );
  assert.equal(prepared.rollbackPayload.status, 'PAUSED');
  assert.equal(prepared.rollbackPayload.action_type, 'restore_campaign_status');
  assert.equal(prepared.action.params.budget_amount_micros, 30_000_000);
  assert.equal(prepared.measurement?.level, 'campaign');

  // The REST API may return the enum as its number (3 = PAUSED).
  await prepareActionForExecution(action('enable_campaign', CAMPAIGN), fakeCustomer({ campaignStatus: 3 }));

  await assert.rejects(
    prepareActionForExecution(action('enable_campaign', CAMPAIGN), fakeCustomer({ campaignStatus: 'ENABLED' })),
    /not PAUSED/
  );
  await assert.rejects(
    prepareActionForExecution(action('enable_campaign', CAMPAIGN), fakeCustomer({ campaignStatus: 'REMOVED' })),
    /not PAUSED/
  );
  await assert.rejects(
    prepareActionForExecution(action('enable_campaign', CAMPAIGN), fakeCustomer({ campaignStatus: 'PAUSED', budgetMicros: 0 })),
    /no positive daily budget/
  );
});

test('Arabic normalisation folds alef, ta marbuta, alef maqsura and diacritics', () => {
  assert.equal(normalizeKeywordText('  أسعار   الشاليهات '), 'اسعار الشاليهات');
  assert.equal(normalizeKeywordText('إيجار'), normalizeKeywordText('ايجار'));
  assert.equal(normalizeKeywordText('آخر'), 'اخر');
  assert.equal(normalizeKeywordText('مدرسة'), normalizeKeywordText('مدرسه'));
  assert.equal(normalizeKeywordText('مستشفى'), normalizeKeywordText('مستشفي'));
  assert.equal(normalizeKeywordText('شَالِيهٌ'), 'شاليه');
  assert.equal(normalizeKeywordText('Free Jobs'), 'free jobs');
});

test('conflict rule: PHRASE matches words in order, EXACT matches equality only', () => {
  assert.equal(negativeWouldBlock('اسعار شاليه', 'PHRASE', 'افضل اسعار شاليه جده'), true);
  assert.equal(negativeWouldBlock('شاليه اسعار', 'PHRASE', 'اسعار شاليه'), false);
  assert.equal(negativeWouldBlock('مجاني', 'PHRASE', 'شاليه مجاني'), true);
  assert.equal(negativeWouldBlock('مجان', 'PHRASE', 'شاليه مجاني'), false);
  assert.equal(negativeWouldBlock('شاليه', 'EXACT', 'شاليه جده'), false);
  assert.equal(negativeWouldBlock('شاليه جده', 'EXACT', 'شاليه جده'), true);
});

test('batch preflight drops existing negatives and anything that would block a converting term or keyword', async () => {
  const customer = fakeCustomer({
    existingNegatives: [
      { text: 'وظائف', matchType: 'PHRASE' },
      { text: 'مجانا', matchType: 'EXACT' }, // different match type: not a duplicate
    ],
    convertingTerms: ['أسعار الشاليهات في جدة'],
    enabledKeywords: ['حجز شاليه'],
  });
  const built = buildExecutableAction(
    batchPayload(['وظائف', 'مجانا', 'اسعار الشاليهات', 'حجز', 'تحميل العاب']),
    rec,
    CID
  );
  assert.ok(built);
  const prepared = await prepareActionForExecution(built, customer);
  assert.deepEqual(prepared.action.params.keywords, ['مجانا', 'تحميل العاب']);
  assert.deepEqual(prepared.action.params.dropped, [
    { text: 'وظائف', reason: 'already_negative' },
    { text: 'اسعار الشاليهات', reason: 'blocks_converting_search_term' },
    { text: 'حجز', reason: 'blocks_enabled_keyword' },
  ]);
  assert.deepEqual(prepared.rollbackPayload, {
    reversible: true,
    action_type: 'remove_created_negative_keywords',
    resource_names_from_result: true,
  });
  assert.equal(prepared.measurement?.level, 'campaign');
  assert.equal(prepared.measurement?.resource, CAMPAIGN);
  const conversionsQuery = customer.queries.find((q) => q.includes('FROM search_term_view'));
  assert.match(conversionsQuery ?? '', /LAST_30_DAYS/);
  assert.match(conversionsQuery ?? '', /metrics\.conversions > 0/);
  assert.match(customer.queries.find((q) => q.includes('FROM campaign_criterion')) ?? '', /negative = TRUE[\s\S]*type = 'KEYWORD'/);
});

test('EXACT batch only conflicts on equality after normalisation', async () => {
  const built = buildExecutableAction(
    batchPayload(['مدرسة', 'مدرسة خاصة'], { match_type: 'EXACT' }),
    rec,
    CID
  );
  assert.ok(built);
  const prepared = await prepareActionForExecution(built, fakeCustomer({ convertingTerms: ['مدرسه'] }));
  assert.deepEqual(prepared.action.params.keywords, ['مدرسة خاصة']);
  assert.deepEqual(prepared.action.params.dropped, [{ text: 'مدرسة', reason: 'blocks_converting_search_term' }]);
});

test('a batch whose every keyword is dropped fails preflight with a clear error', async () => {
  const built = buildExecutableAction(batchPayload(['شاليه']), rec, CID);
  assert.ok(built);
  await assert.rejects(
    prepareActionForExecution(built, fakeCustomer({ convertingTerms: ['شاليه رخيص'] })),
    /Every keyword in the batch was dropped \(شاليه: blocks_converting_search_term\)/
  );
});

test('a failing safety read aborts the batch instead of sending it unchecked', async () => {
  const built = buildExecutableAction(batchPayload(['x']), rec, CID);
  assert.ok(built);
  const customer = fakeCustomer();
  customer.query = async (gaql: string) => {
    if (gaql.includes('search_term_view')) throw new Error('quota');
    return [];
  };
  await assert.rejects(prepareActionForExecution(built, customer), /quota/);
});

// ---------------------------------------------------------------------------
// executeAction / executeRollback call shapes
// ---------------------------------------------------------------------------

test('campaign status and batch mutations have the exact expected shapes', async () => {
  const customer = fakeCustomer();
  await executeAction(action('pause_campaign', CAMPAIGN), customer as any, { validateOnly: true });
  await executeAction(action('enable_campaign', CAMPAIGN), customer as any);
  await executeAction(
    action('add_negative_keywords_batch', CAMPAIGN, { campaign_resource: CAMPAIGN, match_type: 'PHRASE', keywords: ['a', 'b c'] }),
    customer as any
  );
  assert.deepEqual(customer.calls, [
    { service: 'campaigns', op: 'update', items: [{ resource_name: CAMPAIGN, status: 'PAUSED' }], options: { validateOnly: true } },
    { service: 'campaigns', op: 'update', items: [{ resource_name: CAMPAIGN, status: 'ENABLED' }], options: undefined },
    {
      service: 'campaignCriteria',
      op: 'create',
      items: [
        { campaign: CAMPAIGN, keyword: { text: 'a', match_type: 'PHRASE' }, negative: true },
        { campaign: CAMPAIGN, keyword: { text: 'b c', match_type: 'PHRASE' }, negative: true },
      ],
      options: undefined,
    },
  ]);
});

test('rollback restores the previous campaign status and removes every created negative', async () => {
  const customer = fakeCustomer();
  await executeRollback({ action_type: 'restore_campaign_status', campaign_resource: CAMPAIGN, status: 'ENABLED' }, customer as any, { validateOnly: true });
  const names = [`customers/${CID}/campaignCriteria/555~1`, `customers/${CID}/campaignCriteria/555~2`];
  await executeRollback({ action_type: 'remove_created_negative_keywords', resource_names: names }, customer as any);
  assert.deepEqual(customer.calls, [
    { service: 'campaigns', op: 'update', items: [{ resource_name: CAMPAIGN, status: 'ENABLED' }], options: { validateOnly: true } },
    { service: 'campaignCriteria', op: 'remove', items: names, options: undefined },
  ]);

  await assert.rejects(
    executeRollback({ action_type: 'restore_campaign_status', campaign_resource: CAMPAIGN, status: 'REMOVED' }, customer as any),
    /Previous campaign status/
  );
  await assert.rejects(
    executeRollback({ action_type: 'remove_created_negative_keywords', resource_names: [] }, customer as any),
    /unavailable/
  );
  await assert.rejects(
    executeRollback({ action_type: 'remove_created_negative_keywords', resource_names: ['a', 7] }, customer as any),
    /unavailable/
  );
});

// ---------------------------------------------------------------------------
// Shared finalize helper and rollback scoping
// ---------------------------------------------------------------------------

test('finalizeRollbackPayload keeps every batch resource and the single-create behaviour', () => {
  const result = { results: [{ resourceName: 'customers/1/campaignCriteria/5~1' }, { resource_name: 'customers/1/campaignCriteria/5~2' }] };
  assert.deepEqual(resultResourceNames(result), ['customers/1/campaignCriteria/5~1', 'customers/1/campaignCriteria/5~2']);
  assert.deepEqual(
    finalizeRollbackPayload({ reversible: true, action_type: 'remove_created_negative_keywords', resource_names_from_result: true }, result),
    {
      reversible: true,
      action_type: 'remove_created_negative_keywords',
      resource_names_from_result: true,
      resource_names: ['customers/1/campaignCriteria/5~1', 'customers/1/campaignCriteria/5~2'],
    }
  );
  // No names returned: the row must not advertise a rollback it cannot do.
  const empty = finalizeRollbackPayload({ reversible: true, action_type: 'remove_created_negative_keywords' }, {});
  assert.equal(empty.reversible, false);

  assert.deepEqual(
    finalizeRollbackPayload({ reversible: true, action_type: 'remove_created_negative_keyword', resource_name_from_result: true }, result),
    { reversible: true, action_type: 'remove_created_negative_keyword', resource_name_from_result: true, resource_name: 'customers/1/campaignCriteria/5~1' }
  );
  const status = { reversible: true, action_type: 'restore_campaign_status', campaign_resource: CAMPAIGN, status: 'ENABLED' };
  assert.equal(finalizeRollbackPayload(status, result), status);

  const created = { level: 'created_criterion' as const, resource: null, window_days: 7, before: null, captured_at: 'now' };
  assert.equal(finalizeMeasurement(created, result)?.resource, 'customers/1/campaignCriteria/5~1');
});

test('both executors use the one shared finalize helper', () => {
  for (const file of ['lib/recommendations/action-handler.ts', 'lib/autopilot/executor.ts']) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.match(src, /from '@\/lib\/ai\/execution-result'/, file);
    assert.doesNotMatch(src, /function finalizeRollbackPayload/, file);
  }
});

test('rollback scoping checks every resource in a batch and the campaign resource', () => {
  const ok = [`customers/${CID}/campaignCriteria/5~1`, `customers/${CID}/campaignCriteria/5~2`];
  assert.equal(rollbackResourcesScoped({ resource_names: ok }, CID), true);
  assert.equal(rollbackResourcesScoped({ resource_names: [...ok, 'customers/999/campaignCriteria/5~3'] }, CID), false);
  assert.equal(rollbackResourcesScoped({ resource_names: [] }, CID), false);
  assert.equal(rollbackResourcesScoped({ resource_names: 'x' }, CID), false);
  assert.equal(rollbackResourcesScoped({ resource_names: [ok[0], null] }, CID), false);
  assert.equal(rollbackResourcesScoped({ campaign_resource: CAMPAIGN, status: 'ENABLED' }, CID), true);
  assert.equal(rollbackResourcesScoped({ campaign_resource: 'customers/999/campaigns/1' }, CID), false);
  // Pre-existing payload shapes keep working.
  assert.equal(rollbackResourcesScoped({ budget_resource: `customers/${CID}/campaignBudgets/1` }, CID), true);
  assert.equal(rollbackResourcesScoped({}, CID), false);
});

// ---------------------------------------------------------------------------
// Guardrails
// ---------------------------------------------------------------------------

function accountDb(customerId: string | null) {
  return fakeDb((op) =>
    op.table === 'google_ads_accounts'
      ? { data: customerId ? { customer_id: customerId } : null, error: customerId ? null : { message: 'down' } }
      : { data: [], error: null }
  );
}

test('guardrails accept a scoped batch and reject oversize, empty or unscoped ones', async () => {
  const good = action('add_negative_keywords_batch', CAMPAIGN, { campaign_resource: CAMPAIGN, match_type: 'EXACT', keywords: ['a', 'b'] });
  assert.equal(await checkGuardrails(good, 'acc', accountDb(CID)), good);

  const many = { ...good, params: { ...good.params, keywords: Array.from({ length: 11 }, (_, i) => `k${i}`) } };
  assert.equal(await checkGuardrails(many, 'acc', accountDb(CID)), null);
  const none = { ...good, params: { ...good.params, keywords: [] } };
  assert.equal(await checkGuardrails(none, 'acc', accountDb(CID)), null);
  const emptyCampaign = { ...good, target_id: '', params: { ...good.params, campaign_resource: '' } };
  assert.equal(await checkGuardrails(emptyCampaign, 'acc', accountDb(CID)), null);
  const foreign = { ...good, target_id: 'customers/999/campaigns/555', params: { ...good.params, campaign_resource: 'customers/999/campaigns/555' } };
  assert.equal(await checkGuardrails(foreign, 'acc', accountDb(CID)), null);
  const broad = { ...good, params: { ...good.params, match_type: 'BROAD' } };
  assert.equal(await checkGuardrails(broad, 'acc', accountDb(CID)), null);
  // Account metadata unreadable: fail closed.
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.equal(await checkGuardrails(good, 'acc', accountDb(null)), null);
  } finally {
    console.error = originalError;
  }
});

test('guardrails scope campaign status changes to the linked account', async () => {
  const pause = action('pause_campaign', CAMPAIGN);
  assert.equal(await checkGuardrails(pause, 'acc', accountDb(CID)), pause);
  assert.equal(await checkGuardrails(action('enable_campaign', 'customers/999/campaigns/555'), 'acc', accountDb(CID)), null);
  assert.equal(await checkGuardrails(action('enable_campaign', `customers/${CID}/adGroups/1`), 'acc', accountDb(CID)), null);
});

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

test('the nightly measurement pass reads campaign-level metrics for the new operations', async () => {
  const updates: any[] = [];
  const db = fakeDb((op) => {
    if (op.kind === 'update') {
      updates.push(op.values);
      return { data: null, error: null };
    }
    return {
      data: [
        {
          id: 'a1',
          created_at: '2026-10-01T00:00:00Z',
          payload: { measurement: { level: 'campaign', resource: CAMPAIGN, before: { cost: 10, clicks: 1, conversions: 0, conversion_value: 0 } } },
        },
      ],
      error: null,
    };
  });
  const customer = fakeCustomer();
  const outcome = await measureObservedImpacts({ supabase: db, customer, accountId: 'acc' });
  assert.equal(outcome.measured, 1);
  assert.match(customer.queries[0], /FROM campaign\s+WHERE campaign\.resource_name = 'customers\/1234567890\/campaigns\/555'/);
  assert.equal(updates[0].observed_impact.after.cost, 40);
  const inFilter = db.ops[0].filters.find((f) => f[0] === 'in');
  for (const type of ['pause_campaign', 'enable_campaign', 'add_negative_keywords_batch']) {
    assert.ok((inFilter?.[2] as string[]).includes(type), type);
  }
});

// ---------------------------------------------------------------------------
// Optimizer and autopilot stay narrow
// ---------------------------------------------------------------------------

test('the nightly optimizer cannot propose campaign or batch operations', () => {
  const src = readFileSync(new URL('../lib/ai/optimizer-agent.ts', import.meta.url), 'utf8');
  const prompt = src.slice(src.indexOf('const SYSTEM_PROMPT'), src.indexOf('export type ConversionTrackingStatus'));
  const allowed = src.slice(src.indexOf('const ALLOWED_ACTION_TYPES'), src.indexOf('function isWellFormedAction'));
  assert.ok(prompt.length > 100 && allowed.length > 20);
  for (const type of ['pause_campaign', 'enable_campaign', 'add_negative_keywords_batch']) {
    assert.doesNotMatch(prompt, new RegExp(type), `prompt must not mention ${type}`);
    assert.doesNotMatch(allowed, new RegExp(type), `ALLOWED_ACTION_TYPES must not contain ${type}`);
  }
});

test('autopilot still allows add_negative_keyword only', async () => {
  assert.deepEqual([...AUTOPILOT_SAFE_ACTIONS], ['add_negative_keyword']);
  assert.deepEqual(DEFAULT_AUTOPILOT_SETTINGS.allowed_actions, ['add_negative_keyword']);
  const settings = normalizeAutopilotSettings('acc', {
    mode: 'conservative',
    allowed_actions: ['add_negative_keyword', 'pause_campaign', 'enable_campaign', 'add_negative_keywords_batch'],
  });
  assert.deepEqual(settings.allowed_actions, ['add_negative_keyword']);

  for (const candidate of [
    action('pause_campaign', CAMPAIGN),
    action('add_negative_keywords_batch', CAMPAIGN, { campaign_resource: CAMPAIGN, match_type: 'EXACT', keywords: ['x'] }),
  ]) {
    const verdict = evaluateAutopilotPolicy({
      settings: { ...settings, allowed_actions: ['add_negative_keyword', candidate.type] },
      action: candidate,
      trackingStatus: 'healthy',
      globalExecutionEnabled: true,
      executedToday: 0,
      sameTargetExecutedWithinCooldown: false,
    });
    assert.equal(verdict.outcome, 'queue');
    assert.equal(verdict.code, 'manual_action_type');
  }
});

test('the autopilot executor refuses a batch even if a caller passes one', async () => {
  const db = fakeDb((op) => {
    if (op.table === 'recommendations' && op.kind === 'insert') {
      return { data: { id: 'r-auto', title: 't', description: 'd', expected_impact: {} }, error: null };
    }
    return { data: null, error: null };
  });
  const customer = fakeCustomer();
  const outcome = await executeAutopilotAction({
    supabase: db,
    customer,
    accountId: 'acc',
    customerId: CID,
    action: action('add_negative_keywords_batch', CAMPAIGN, { campaign_resource: CAMPAIGN, match_type: 'EXACT', keywords: ['x'] }),
    verdict: { outcome: 'execute', code: 'policy_approved', reason_ar: 'x', checks: [] },
    fingerprint: 'fp',
    ownerUserId: 'owner',
  });
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.message ?? '', /executable-action boundary/);
  assert.equal(customer.calls.length, 0);
  assert.equal(customer.queries.length, 0);
});

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

test('the new operations carry Arabic labels without em or en dashes', () => {
  assert.equal(OPERATION_LABELS_AR.pause_campaign, 'إيقاف حملة');
  assert.equal(OPERATION_LABELS_AR.enable_campaign, 'تشغيل حملة');
  assert.equal(OPERATION_LABELS_AR.add_negative_keywords_batch, 'منع عبارات بحث (دفعة)');
  for (const label of Object.values(OPERATION_LABELS_AR)) assert.doesNotMatch(label, /[\u2013\u2014]/);

  const page = readFileSync(new URL('../app/(dashboard)/optimizer/page.tsx', import.meta.url), 'utf8');
  for (const label of ['إيقاف حملة', 'تشغيل حملة', 'منع عبارات بحث (دفعة)']) assert.ok(page.includes(label), label);

  const state: ChatState = {
    accountLinked: true,
    accountName: null,
    customerId: CID,
    currency: 'SAR',
    latestAudit: null,
    recommendations: [],
    subscriptionActive: true,
  };
  const turn = planApply(state, {
    id: 'r1',
    title: 'أوقف الحملة',
    description: 'تصرف بلا نتيجة',
    severity: 'critical',
    status: 'pending',
    executable: true,
    operation: 'pause_campaign',
  });
  const card = turn.cards.find((c) => c.kind === 'approval');
  assert.ok(card && card.kind === 'approval');
  assert.deepEqual(card.changes, ['نوع التغيير: إيقاف حملة', 'تصرف بلا نتيجة']);
});

// ---------------------------------------------------------------------------
// Route: approve_execute shares the approve and execute paths
// ---------------------------------------------------------------------------

type RouteWorld = {
  status: string;
  payload: any;
  aiActions: any[];
  consumed: number;
  refunded: number;
  subscriptionActive?: boolean;
  /** Stripe-style status the fake access reports, default 'active'. */
  subscriptionStatus?: string;
  suspended?: boolean;
  /** Plan on the fake access; defaults to 'pro' (null when the caller has no access at all). */
  plan?: string | null;
};

function routeHarness(world: RouteWorld, customer: ReturnType<typeof fakeCustomer>, overrides: Record<string, any> = {}) {
  const account = { id: 'acc', customer_id: CID, manager_id: null, currency_code: 'SAR', refresh_token_encrypted: 'enc' };
  const server = {
    auth: { getUser: async () => ({ data: { user: { id: 'user-1', email: 'u@example.com' } } }) },
    ...fakeDb((op) => {
      if (op.table === 'recommendations') {
        return {
          data: { id: 'rec-1', account_id: 'acc', title: 'عنوان', description: 'وصف', expected_impact: {}, action_payload: world.payload, status: world.status },
          error: null,
        };
      }
      if (op.table === 'google_ads_accounts') return { data: account, error: null };
      return { data: [], error: null };
    }),
  };
  const admin = fakeDb((op) => {
    if (op.table === 'ai_actions' && op.kind === 'insert') {
      world.aiActions.push(op.values);
      return { data: { id: `log-${world.aiActions.length}` }, error: null };
    }
    if (op.table === 'recommendations' && op.kind === 'update') {
      const eqStatus = op.filters.find((f) => f[0] === 'eq' && f[1] === 'status');
      const inStatus = op.filters.find((f) => f[0] === 'in' && f[1] === 'status');
      const matches =
        (!eqStatus || eqStatus[2] === world.status) &&
        (!inStatus || (inStatus[2] as string[]).includes(world.status));
      if (!matches) return { data: null, error: null };
      if (op.values.status) world.status = op.values.status;
      return { data: { id: 'rec-1' }, error: null };
    }
    return { data: null, error: null };
  });

  const handler = createRecommendationActionHandler({
    createServerClient: (async () => server) as any,
    createAdminClient: (() => admin) as any,
    checkRateLimit: (async () => ({ allowed: true, remaining: 10, resetAt: '', retryAfterSeconds: 0 })) as any,
    decrypt: () => 'refresh-token',
    getCustomer: (() => customer) as any,
    getSubscriptionAccess: (async () => ({
      active: world.subscriptionActive ?? true,
      plan: world.plan === undefined ? 'pro' : world.plan,
      status: world.subscriptionStatus ?? 'active',
      trialEndsAt: null,
      currentPeriodEnd: null,
      ...(world.suspended ? { suspended: true } : {}),
    })) as any,
    consumeFeatureUsage: (async () => {
      world.consumed += 1;
      return { ok: true, plan: 'pro', limit: 100, used: 1, remaining: 99, resetsAt: '', usageEventId: 'usage-1' };
    }) as any,
    refundFeatureUsage: (async () => {
      world.refunded += 1;
      return true;
    }) as any,
    sendOpsAlert: (async () => ({ sent: true, id: 'ops' })) as any,
    randomUUID: () => 'exec-key-1' as `${string}-${string}-${string}-${string}-${string}`,
    ...overrides,
  });

  return async (intent: string) => {
    const body = new URLSearchParams({ recommendation_id: 'rec-1', intent, next: '/optimizer' });
    const response = await handler(
      new NextRequest('http://localhost/api/recommendations/action', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      })
    );
    return { status: response.status, location: response.headers.get('location') ?? '' };
  };
}

function world(status: string, payload: any, extra: Partial<RouteWorld> = {}): RouteWorld {
  return { status, payload, aiActions: [], consumed: 0, refunded: 0, ...extra };
}

test('approve_execute approves then runs the full execute path for a pending campaign pause', async () => {
  const w = world('pending', { operation: 'pause_campaign', target_id: CAMPAIGN });
  const customer = fakeCustomer({ campaignStatus: 'ENABLED' });
  const result = await routeHarness(w, customer)('approve_execute');

  assert.equal(result.status, 303);
  assert.match(result.location, /\/optimizer\?executed=1$/);
  assert.equal(w.status, 'applied');
  assert.equal(w.consumed, 1);
  assert.deepEqual(w.aiActions.map((row) => row.action_type), ['approval_queued', 'pause_campaign']);
  assert.equal(w.aiActions[0].payload.approved_via, 'approve_execute');
  assert.deepEqual(w.aiActions[1].rollback_payload, {
    reversible: true,
    action_type: 'restore_campaign_status',
    campaign_resource: CAMPAIGN,
    status: 'ENABLED',
  });
  assert.equal(w.aiActions[1].payload.measurement.level, 'campaign');
  assert.deepEqual(
    customer.calls.map((c) => [c.service, (c.options as any)?.validateOnly ?? false]),
    [['campaigns', true], ['campaigns', false]]
  );
});

test('approve_execute also works from a failed recommendation', async () => {
  const w = world('failed', { operation: 'enable_campaign', target_id: CAMPAIGN });
  const result = await routeHarness(w, fakeCustomer({ campaignStatus: 'PAUSED' }))('approve_execute');
  assert.match(result.location, /executed=1/);
  assert.equal(w.status, 'applied');
});

test('approve_execute on a locked recommendation redirects without executing', async () => {
  for (const status of ['approved', 'executing', 'applied', 'dismissed']) {
    const w = world(status, { operation: 'pause_campaign', target_id: CAMPAIGN });
    const customer = fakeCustomer();
    const result = await routeHarness(w, customer)('approve_execute');
    assert.match(result.location, /error=recommendation_locked$/, status);
    assert.equal(w.status, status);
    assert.equal(w.aiActions.length, 0);
    assert.equal(w.consumed, 0);
    assert.equal(customer.calls.length + customer.queries.length, 0);
  }
});

test('approve_execute keeps every execute check: a failed preflight leaves the row failed and spends no quota', async () => {
  const w = world('pending', { operation: 'pause_campaign', target_id: CAMPAIGN });
  const customer = fakeCustomer({ campaignStatus: 'PAUSED' });
  const result = await routeHarness(w, customer)('approve_execute');
  assert.match(result.location, /error=execution_failed$/);
  assert.equal(w.status, 'failed');
  assert.equal(w.consumed, 0);
  assert.deepEqual(w.aiActions.map((row) => row.action_type), ['approval_queued', 'preflight_failed']);
  assert.equal(customer.calls.length, 0);
});

test('without access NOTHING is approved or executed: approve, approve_execute and execute all stop at the door', async () => {
  const noAccess: Array<[string, Partial<RouteWorld>]> = [
    ['no subscription at all', { subscriptionActive: false, plan: null, subscriptionStatus: 'none' }],
    ['a lapsed subscription', { subscriptionActive: false, subscriptionStatus: 'canceled' }],
    ['a suspended account that otherwise has a plan', { suspended: true }],
  ];
  for (const [label, extra] of noAccess) {
    for (const intent of ['approve', 'approve_execute', 'execute']) {
      const w = world(intent === 'execute' ? 'approved' : 'pending', { operation: 'pause_campaign', target_id: CAMPAIGN }, extra);
      const before = w.status;
      const customer = fakeCustomer();
      const result = await routeHarness(w, customer)(intent);
      assert.equal(result.status, 303, `${label} ${intent}`);
      assert.match(result.location, /error=subscription_required$/, `${label} ${intent}`);
      assert.equal(w.status, before, `${label} ${intent} must leave the row untouched`);
      assert.equal(w.aiActions.length, 0, `${label} ${intent} writes no action log`);
      assert.equal(w.consumed, 0);
      assert.equal(customer.calls.length + customer.queries.length, 0, `${label} ${intent} never touches Google Ads`);
    }
  }
});

test('a live trial and an active subscription pass the door; dismissing needs no access at all', async () => {
  for (const status of ['trialing', 'active']) {
    const w = world('pending', { operation: 'pause_campaign', target_id: CAMPAIGN }, { subscriptionStatus: status });
    const result = await routeHarness(w, fakeCustomer({ campaignStatus: 'ENABLED' }))('approve_execute');
    assert.match(result.location, /executed=1/, status);
    assert.equal(w.status, 'applied', status);
  }
  const approved = world('pending', { operation: 'pause_campaign', target_id: CAMPAIGN }, { subscriptionStatus: 'trialing' });
  await routeHarness(approved, fakeCustomer())('approve');
  assert.equal(approved.status, 'approved');

  const w = world('pending', { operation: 'pause_campaign', target_id: CAMPAIGN }, { subscriptionActive: false, plan: null });
  const result = await routeHarness(w, fakeCustomer())('dismiss');
  assert.doesNotMatch(result.location, /subscription_required/);
  assert.equal(w.status, 'dismissed');
});

test('approve_execute rejects a payload for another account after approval, before any Google call', async () => {
  const w = world('pending', { operation: 'pause_campaign', target_id: 'customers/999/campaigns/555' });
  const customer = fakeCustomer();
  const result = await routeHarness(w, customer)('approve_execute');
  assert.match(result.location, /error=blocked_by_guardrails$/);
  assert.equal(w.status, 'failed');
  assert.deepEqual(w.aiActions.map((row) => row.action_type), ['approval_queued', 'resource_account_mismatch']);
  assert.equal(customer.calls.length + customer.queries.length, 0);
});

test('a batch executes as ONE mutate with N operations, ONE quota unit, and a full rollback list', async () => {
  const w = world('pending', batchPayload(['وظائف', 'تحميل', 'اسعار الشاليهات']));
  const customer = fakeCustomer({ convertingTerms: ['أسعار الشاليهات جدة'] });
  const result = await routeHarness(w, customer)('approve_execute');
  assert.match(result.location, /executed=1/);
  assert.equal(w.consumed, 1);

  const creates = customer.calls.filter((c) => c.service === 'campaignCriteria' && c.op === 'create');
  assert.equal(creates.length, 2, 'validateOnly then live, nothing more');
  assert.equal((creates[0].options as any)?.validateOnly, true);
  assert.equal(creates[1].items.length, 2);

  const log = w.aiActions.find((row) => row.action_type === 'add_negative_keywords_batch');
  assert.ok(log);
  assert.deepEqual(log.payload.action.params.keywords, ['وظائف', 'تحميل']);
  assert.deepEqual(log.payload.action.params.dropped, [{ text: 'اسعار الشاليهات', reason: 'blocks_converting_search_term' }]);
  assert.deepEqual(log.rollback_payload.resource_names, [
    `customers/${CID}/campaignCriteria/555~900`,
    `customers/${CID}/campaignCriteria/555~901`,
  ]);
  assert.equal(rollbackResourcesScoped(log.rollback_payload, CID), true);
});

test('existing intents are unchanged: approve only approves, execute needs approval, dismiss dismisses', async () => {
  const approveWorld = world('pending', { operation: 'pause_campaign', target_id: CAMPAIGN });
  const approveCustomer = fakeCustomer();
  const approved = await routeHarness(approveWorld, approveCustomer)('approve');
  assert.match(approved.location, /approved=1$/);
  assert.equal(approveWorld.status, 'approved');
  assert.deepEqual(approveWorld.aiActions.map((row) => row.action_type), ['approval_queued']);
  assert.equal(approveWorld.aiActions[0].payload.approved_via, undefined);
  assert.equal(approveCustomer.calls.length + approveCustomer.queries.length, 0);

  const executeWorld = world('pending', { operation: 'pause_campaign', target_id: CAMPAIGN });
  const notApproved = await routeHarness(executeWorld, fakeCustomer())('execute');
  assert.match(notApproved.location, /error=approve_before_execution$/);
  assert.equal(executeWorld.status, 'pending');

  const twoStep = world('approved', { operation: 'pause_campaign', target_id: CAMPAIGN });
  const executed = await routeHarness(twoStep, fakeCustomer({ campaignStatus: 'ENABLED' }))('execute');
  assert.match(executed.location, /executed=1$/);
  assert.equal(twoStep.status, 'applied');
  assert.deepEqual(twoStep.aiActions.map((row) => row.action_type), ['pause_campaign']);

  const dismissWorld = world('pending', { operation: 'pause_campaign', target_id: CAMPAIGN });
  const dismissed = await routeHarness(dismissWorld, fakeCustomer())('dismiss');
  assert.match(dismissed.location, /updated=1$/);
  assert.equal(dismissWorld.status, 'dismissed');

  const unknown = await routeHarness(world('pending', {}), fakeCustomer())('approve_and_run');
  assert.match(unknown.location, /error=invalid_recommendation_action$/);
});

test('growth approval waits for the owned account scope then validates and executes instead of manual review', async () => {
  const previous=process.env.AUDIENCES_ENABLED;process.env.AUDIENCES_ENABLED='true';
  try {
    const w=world('pending',{operation:'create_user_list',params:{kind:'website_visitors',name:'زوار النشاط',url_contains:'example.com',lookback_days:30}});
    const calls: boolean[]=[];
    const result=await routeHarness(w,fakeCustomer(),{prepareActionForExecution:async(action:any)=>{assert.equal(action.params.customer_id,CID);return {action,rollbackPayload:{reversible:false},measurement:null};},checkGuardrails:async(action:any)=>action,executeAction:async(_action:any,_customer:any,options:any)=>{calls.push(options?.validateOnly===true);return {};}})('approve_execute');
    assert.match(result.location,/executed=1/);assert.equal(w.status,'applied');assert.deepEqual(calls,[true,false]);
  } finally {if(previous===undefined)delete process.env.AUDIENCES_ENABLED;else process.env.AUDIENCES_ENABLED=previous;}
});
