import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyGoogleRecommendation, summarizeVerdicts } from '../lib/recommendations/google-triage';
import { getGoogleRecommendationsTool } from '../lib/jarvis/tools/get-google-recommendations';
import { JARVIS_READ_TOOLS } from '../lib/jarvis/tools';
import { EvidenceRegistry } from '../lib/jarvis/evidence';
import {
  PREPARE_CHANGE_TOOL,
  PREPARE_OPERATIONS,
  prepareChange,
  prepareChangeToolFor,
  type PrepareContext,
} from '../lib/jarvis/prepare-change';
import type { EvidenceRow, ToolContext } from '../lib/jarvis/tools';
import { OAuth2Client } from 'google-auth-library';
import { getCustomer } from '../lib/google-ads/client';

const CID = '1234567890';
const CUSTOMER = `customers/${CID}`;
const CAMPAIGN = `${CUSTOMER}/campaigns/11`;
const REC = `${CUSTOMER}/recommendations/abc`;
const SUB = `${CUSTOMER}/recommendationSubscriptions/SITELINK_ASSET`;

function withFlag<T>(value: string | undefined, fn: () => T): T {
  const old = process.env.EXTENDED_ACTIONS_ENABLED;
  if (value === undefined) delete process.env.EXTENDED_ACTIONS_ENABLED;
  else process.env.EXTENDED_ACTIONS_ENABLED = value;
  try {
    return fn();
  } finally {
    if (old === undefined) delete process.env.EXTENDED_ACTIONS_ENABLED;
    else process.env.EXTENDED_ACTIONS_ENABLED = old;
  }
}

async function withFlagAsync<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const old = process.env.EXTENDED_ACTIONS_ENABLED;
  if (value === undefined) delete process.env.EXTENDED_ACTIONS_ENABLED;
  else process.env.EXTENDED_ACTIONS_ENABLED = value;
  try {
    return await fn();
  } finally {
    if (old === undefined) delete process.env.EXTENDED_ACTIONS_ENABLED;
    else process.env.EXTENDED_ACTIONS_ENABLED = old;
  }
}

// ---------------------------------------------------------------------------
// Recommendation classifier
// ---------------------------------------------------------------------------

const lowData = { conversions_30d: 12, target_met: false };
const richData = { conversions_30d: 80, target_met: true };

test('classifier accepts sitelink and callout assets and marks them appliable', () => {
  for (const type of ['SITELINK_ASSET', 'CALLOUT_ASSET']) {
    const r = classifyGoogleRecommendation({ type }, lowData);
    assert.equal(r.verdict, 'accept');
    assert.equal(r.applicable, true);
  }
});

test('classifier rejects keyword clean-up that hands traffic to Performance Max', () => {
  for (const type of ['REMOVE_REDUNDANT_KEYWORDS', 'KEYWORD_REMOVE_UNUSED', 'DUPLICATE_KEYWORD']) {
    const r = classifyGoogleRecommendation({ type }, richData);
    assert.equal(r.verdict, 'reject', type);
    assert.match(r.reason_ar, /الأداء الأقصى/);
  }
});

test('classifier rejects broad match without enough conversions and reviews it with enough', () => {
  assert.equal(classifyGoogleRecommendation({ type: 'USE_BROAD_MATCH_KEYWORD' }, lowData).verdict, 'reject');
  assert.equal(classifyGoogleRecommendation({ type: 'KEYWORD_MATCH_TYPE' }, { conversions_30d: null, target_met: null }).verdict, 'reject');
  assert.equal(classifyGoogleRecommendation({ type: 'USE_BROAD_MATCH_KEYWORD' }, richData).verdict, 'needs_review');
});

test('classifier rejects budget raises unless the target is proven met', () => {
  for (const type of ['CAMPAIGN_BUDGET', 'FORECASTING_CAMPAIGN_BUDGET', 'MARGINAL_ROI_CAMPAIGN_BUDGET', 'MOVE_UNUSED_BUDGET']) {
    assert.equal(classifyGoogleRecommendation({ type }, lowData).verdict, 'reject', type);
    assert.equal(classifyGoogleRecommendation({ type }, { conversions_30d: 80, target_met: null }).verdict, 'reject', type);
    assert.equal(classifyGoogleRecommendation({ type }, richData).verdict, 'needs_review', type);
  }
});

test('classifier keeps networks and Performance Max opt-ins off, gates Smart Bidding opt-ins on data', () => {
  for (const type of ['SEARCH_PARTNERS_OPT_IN', 'DISPLAY_EXPANSION_OPT_IN', 'PERFORMANCE_MAX_OPT_IN', 'MAXIMIZE_CLICKS_OPT_IN']) {
    assert.equal(classifyGoogleRecommendation({ type }, richData).verdict, 'reject', type);
  }
  assert.equal(classifyGoogleRecommendation({ type: 'TARGET_CPA_OPT_IN' }, lowData).verdict, 'reject');
  assert.equal(classifyGoogleRecommendation({ type: 'TARGET_CPA_OPT_IN' }, richData).verdict, 'needs_review');
});

test('classifier defaults to needs_review and every reason is clean Arabic', () => {
  const types = [
    'KEYWORD', 'CALL_ASSET', 'LEAD_FORM_ASSET', 'RESPONSIVE_SEARCH_AD', 'SOMETHING_NEW', 'SITELINK_ASSET',
    'CAMPAIGN_BUDGET', 'USE_BROAD_MATCH_KEYWORD', 'SEARCH_PARTNERS_OPT_IN', 'TARGET_CPA_OPT_IN', 'REMOVE_REDUNDANT_KEYWORDS',
  ];
  for (const type of types) {
    for (const ctx of [lowData, richData]) {
      const r = classifyGoogleRecommendation({ type }, ctx);
      assert.ok(['accept', 'reject', 'needs_review'].includes(r.verdict));
      assert.match(r.reason_ar, /[؀-ۿ]/);
      assert.doesNotMatch(r.reason_ar, /[–—,]/);
    }
  }
  assert.equal(classifyGoogleRecommendation({ type: 'SOMETHING_NEW' }, richData).verdict, 'needs_review');
  assert.deepEqual(summarizeVerdicts([{ verdict: 'accept' }, { verdict: 'reject' }, { verdict: 'reject' }]), {
    accept: 1,
    reject: 2,
    needs_review: 0,
  });
});

// ---------------------------------------------------------------------------
// Jarvis read tool
// ---------------------------------------------------------------------------

function toolCtx(answers: { recs?: any[] | Error; minimal?: any[]; subs?: any[] | Error }): ToolContext {
  return {
    accountId: 'acc',
    customerId: CID,
    currencyCode: 'SAR',
    business: null,
    now: new Date('2026-10-19T10:00:00Z'),
    customer: {
      async query(gaql: string) {
        if (gaql.includes('FROM recommendation_subscription')) {
          if (answers.subs instanceof Error) throw answers.subs;
          return answers.subs ?? [];
        }
        if (gaql.includes('FROM recommendation')) {
          if (answers.recs instanceof Error) {
            if (gaql.includes('impact.base_metrics')) throw answers.recs;
            return answers.minimal ?? [];
          }
          return answers.recs ?? [];
        }
        if (gaql.includes('FROM customer')) return [{ metrics: { conversions: 40 } }];
        if (gaql.includes('FROM campaign')) return [{ campaign: { resourceName: CAMPAIGN, name: 'حملة العسل' } }];
        return [];
      },
    },
  };
}

const recRow = (type: string, extra: Record<string, unknown> = {}) => ({
  recommendation: { resourceName: `${CUSTOMER}/recommendations/${type}`, type, dismissed: false, campaign: CAMPAIGN, ...extra },
});

test('get_google_recommendations returns verdicts, hides resource names, keeps them as evidence', async () => {
  const result = await getGoogleRecommendationsTool.run(
    {},
    toolCtx({
      recs: [recRow('SITELINK_ASSET'), recRow('CAMPAIGN_BUDGET'), recRow('KEYWORD'), recRow('CALLOUT_ASSET', { dismissed: true })],
      subs: [{ recommendationSubscription: { resourceName: SUB, type: 'SITELINK_ASSET', status: 'ENABLED' } }],
    })
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const summary = result.summary as any;
  assert.equal(summary.total_open, 3);
  assert.deepEqual(summary.by_verdict, { accept: 1, reject: 1, needs_review: 1 });
  assert.doesNotMatch(JSON.stringify(summary), /customers\//);
  assert.equal(summary.auto_apply.readable, true);
  assert.equal(summary.auto_apply.enabled_count, 1);
  const evidence = result.rows.find((r) => r.kind === 'google_recommendation')!;
  assert.match(String(evidence.data.resource_name), /^customers\//);
  assert.ok(result.rows.some((r) => r.kind === 'auto_apply' && (r.data.subscription_resources as string[]).includes(SUB)));
  const campaignName = summary.recommendations[0].campaign;
  assert.equal(campaignName, 'حملة العسل');
});

test('get_google_recommendations degrades: no impact fields, unreadable subscriptions, unreadable list', async () => {
  const degraded = await getGoogleRecommendationsTool.run(
    {},
    toolCtx({ recs: new Error('field'), minimal: [recRow('SITELINK_ASSET')], subs: new Error('nope') })
  );
  assert.equal(degraded.ok, true);
  if (degraded.ok) {
    assert.equal((degraded.summary as any).auto_apply.readable, false);
    assert.match(String((degraded.summary as any).auto_apply.note_ar), /اطفه من الإعدادات/);
  }
  await assert.rejects(
    getGoogleRecommendationsTool.run({}, {
      ...toolCtx({}),
      customer: { async query() { throw new Error('down'); } },
    }),
    /unreadable/
  );
  await assert.rejects(getGoogleRecommendationsTool.run({ extra: 1 }, toolCtx({})), /unknown field|allowed/);
});

test('flag off keeps the read tool list free of the new tool', () => {
  withFlag(undefined, () => {
    assert.ok(!JARVIS_READ_TOOLS.some((t) => t.name === 'get_google_recommendations'));
  });
  assert.ok(JARVIS_READ_TOOLS.length >= 10);
});

// ---------------------------------------------------------------------------
// prepare_change
// ---------------------------------------------------------------------------

function fakeAdmin() {
  const inserted: any[] = [];
  const from = (table: string) => {
    let op = 'select';
    let payload: any;
    const builder: any = {
      select: () => builder,
      insert: (p: any) => {
        op = 'insert';
        payload = p;
        return builder;
      },
      maybeSingle: () => Promise.resolve(op === 'insert' ? (inserted.push({ table, payload }), { data: { id: 'rec-new' }, error: null }) : { data: null, error: null }),
      then: (resolve: any) => resolve({ data: [], error: null, count: 0 }),
    };
    for (const name of ['eq', 'in', 'gte', 'lte', 'order', 'limit']) builder[name] = () => builder;
    return builder;
  };
  return { from, inserted };
}

function registryWith(rows: EvidenceRow[]) {
  const registry = new EvidenceRegistry();
  registry.add({ items: rows.map((row) => ({ ref: row.ref })) }, rows);
  return registry;
}

function prepareCtx(registry: EvidenceRegistry, admin: any): PrepareContext {
  return {
    registry,
    accountId: '00000000-0000-4000-8000-000000000001',
    customerId: CID,
    currencyCode: 'SAR',
    sessionId: null,
    subscriptionActive: true,
    admin,
    proposalsThisTurn: 0,
    now: new Date('2026-10-19T10:00:00Z'),
    deps: { checkGuardrails: async (action) => action, findBlocking: async () => null },
  };
}

const campaignRow = (ref = 'cmp_1'): EvidenceRow => ({
  ref,
  kind: 'campaign',
  data: { id: '11', name: 'حملة العسل', resource_name: CAMPAIGN, status: 'ENABLED', budget_resource_name: `${CUSTOMER}/campaignBudgets/9`, budget_micros: 50_000_000 },
});

test('prepare_change tool is unchanged with the flag off and extended with it on', () => {
  assert.equal(prepareChangeToolFor(false), PREPARE_CHANGE_TOOL);
  assert.ok(!JSON.stringify(PREPARE_CHANGE_TOOL).includes('set_ad_schedule'));
  const extended: any = prepareChangeToolFor(true);
  assert.ok(extended.input_schema.properties.operation.enum.includes('set_ad_schedule'));
  for (const op of PREPARE_OPERATIONS) assert.ok(extended.input_schema.properties.operation.enum.includes(op));
  assert.ok(extended.input_schema.properties.choices.properties.delta_pct);
  assert.ok(extended.input_schema.properties.choices.properties.device);
});

test('prepare_change refuses extended operations while the flag is off', async () => {
  await withFlagAsync(undefined, async () => {
    const out = await prepareChange(
      { operation: 'set_network_settings', evidence_refs: ['cmp_1'], choices: { networks: ['display'] }, why_ar: 'x' },
      prepareCtx(registryWith([campaignRow()]), fakeAdmin())
    );
    assert.equal(out.ok, false);
    if (!out.ok) assert.equal(out.code, 'unknown_operation');
  });
});

test('prepare_change builds a network card and stores a canonical payload (flag on)', async () => {
  await withFlagAsync('true', async () => {
    const admin = fakeAdmin();
    const out = await prepareChange(
      { operation: 'set_network_settings', evidence_refs: ['cmp_1'], choices: { networks: ['search_partners', 'display'] }, why_ar: 'نوقف الصرف الضعيف' },
      prepareCtx(registryWith([campaignRow()]), admin)
    );
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.equal(out.created, true);
    const row = admin.inserted.find((i) => i.table === 'recommendations')!.payload;
    assert.equal(row.category, 'targeting');
    assert.equal(row.action_payload.operation, 'set_network_settings');
    assert.deepEqual(row.action_payload.params, {
      campaign_resource: CAMPAIGN,
      target_search_network: false,
      target_content_network: false,
    });
  });
});

test('prepare_change device modifier needs a campaign ref and a device (flag on)', async () => {
  await withFlagAsync('true', async () => {
    const ctx = () => prepareCtx(registryWith([campaignRow()]), fakeAdmin());
    const ok = await prepareChange(
      { operation: 'set_device_bid_modifier', evidence_refs: ['cmp_1'], choices: { device: 'MOBILE', modifier_pct: -20 }, why_ar: 'x' },
      ctx()
    );
    assert.equal(ok.ok, true);
    const noDevice = await prepareChange(
      { operation: 'set_device_bid_modifier', evidence_refs: ['cmp_1'], choices: { modifier_pct: -20 }, why_ar: 'x' },
      ctx()
    );
    assert.equal(noDevice.ok, false);
    const outOfBounds = await prepareChange(
      { operation: 'set_device_bid_modifier', evidence_refs: ['cmp_1'], choices: { device: 'MOBILE', modifier_pct: -70 }, why_ar: 'x' },
      ctx()
    );
    assert.equal(outOfBounds.ok, false);
  });
});

test('prepare_change recommendation operations check the verdict and never trust typed resources', async () => {
  await withFlagAsync('true', async () => {
    const rec = (verdict: string, applicable: boolean): EvidenceRow => ({
      ref: 'gr_1',
      kind: 'google_recommendation',
      data: { type: applicable ? 'SITELINK_ASSET' : 'CAMPAIGN_BUDGET', verdict, applicable, reason_ar: 'سبب', resource_name: REC, campaign: 'حملة' },
    });
    const apply = await prepareChange(
      { operation: 'apply_google_recommendation', evidence_refs: ['gr_1'], why_ar: 'x' },
      prepareCtx(registryWith([rec('accept', true)]), fakeAdmin())
    );
    assert.equal(apply.ok, true);
    const wrong = await prepareChange(
      { operation: 'apply_google_recommendation', evidence_refs: ['gr_1'], why_ar: 'x' },
      prepareCtx(registryWith([rec('reject', false)]), fakeAdmin())
    );
    assert.equal(wrong.ok, false);
    const dismiss = await prepareChange(
      { operation: 'dismiss_google_recommendation', evidence_refs: ['gr_1'], why_ar: 'x' },
      prepareCtx(registryWith([rec('reject', false)]), fakeAdmin())
    );
    assert.equal(dismiss.ok, true);
    const aa = await prepareChange(
      { operation: 'pause_auto_apply', evidence_refs: ['aa_1'], why_ar: 'x' },
      prepareCtx(registryWith([{ ref: 'aa_1', kind: 'auto_apply', data: { subscription_resources: [SUB], types: ['SITELINK_ASSET'] } }]), fakeAdmin())
    );
    assert.equal(aa.ok, true);
  });
});

test('prepare_change shared list builds keywords from wasted-term rows only', async () => {
  await withFlagAsync('true', async () => {
    const waste = (ref: string, term: string, conversions = 0): EvidenceRow => ({
      ref,
      kind: 'search_term',
      data: { term, term_raw: term, role: 'waste', conversions, cost: 20, clicks: 4, campaign_resource_name: CAMPAIGN },
    });
    const admin = fakeAdmin();
    const ok = await prepareChange(
      { operation: 'create_shared_negative_list', evidence_refs: ['st_1', 'st_2', 'cmp_1'], choices: { list_name: 'منع الباحثين عن وظائف' }, why_ar: 'x' },
      prepareCtx(registryWith([waste('st_1', 'وظائف'), waste('st_2', 'مجاني'), campaignRow()]), admin)
    );
    assert.equal(ok.ok, true);
    const params = admin.inserted[0].payload.action_payload.params;
    assert.deepEqual(params.keywords.map((k: any) => k.text), ['وظائف', 'مجاني']);
    assert.deepEqual(params.campaign_resources, [CAMPAIGN]);
    const converting = await prepareChange(
      { operation: 'create_shared_negative_list', evidence_refs: ['st_1', 'cmp_1'], choices: { list_name: 'قائمة' }, why_ar: 'x' },
      prepareCtx(registryWith([waste('st_1', 'وظائف', 2), campaignRow()]), fakeAdmin())
    );
    assert.equal(converting.ok, false);
  });
});

// ---------------------------------------------------------------------------
// REST client shims
// ---------------------------------------------------------------------------

test('getCustomer posts mutateOperations to googleAds:mutate once and maps results', async () => {
  const realFetch = globalThis.fetch;
  const oldToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  process.env.GOOGLE_ADS_DEVELOPER_TOKEN = 'dev-token';
  const oauthKeys = ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_OAUTH_REDIRECT_URI'] as const;
  const oldOauth = oauthKeys.map((k) => process.env[k]);
  for (const k of oauthKeys) process.env[k] = 'x';
  const realGetAccessToken = OAuth2Client.prototype.getAccessToken;
  (OAuth2Client.prototype as any).getAccessToken = async () => ({ token: 'tok' });
  const calls: Array<{ url: string; body: any }> = [];
  globalThis.fetch = (async (url: any, init: any) => {
    const href = String(url);
    if (href.includes('oauth2')) {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    calls.push({ url: href, body: init?.body ? JSON.parse(init.body) : null });
    return new Response(
      JSON.stringify({ mutateOperationResponses: [{ sharedSetResult: { resourceName: `${CUSTOMER}/sharedSets/5` } }, { sharedCriterionResult: { resourceName: `${CUSTOMER}/sharedCriteria/5~6` } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }) as typeof fetch;
  try {
    const customer: any = getCustomer(CID, 'refresh-token-ext-test');
    const out = await customer.mutateOperations(
      [{ shared_set_operation: { create: { resource_name: `${CUSTOMER}/sharedSets/-1`, name: 'n', type: 'NEGATIVE_KEYWORDS' } } }],
      { validateOnly: true }
    );
    assert.deepEqual(out.results, [{ resourceName: `${CUSTOMER}/sharedSets/5` }, { resourceName: `${CUSTOMER}/sharedCriteria/5~6` }]);
    const call = calls.at(-1)!;
    assert.match(call.url, /\/customers\/1234567890\/googleAds:mutate$/);
    assert.equal(call.body.validateOnly, true);
    assert.equal(call.body.mutateOperations[0].sharedSetOperation.create.resourceName, `${CUSTOMER}/sharedSets/-1`);
    await customer.recommendations.dismiss([{ resource_name: REC }]);
    assert.match(calls.at(-1)!.url, /recommendations:dismiss$/);
    assert.deepEqual(calls.at(-1)!.body, { operations: [{ resourceName: REC }] });
  } finally {
    globalThis.fetch = realFetch;
    OAuth2Client.prototype.getAccessToken = realGetAccessToken;
    oauthKeys.forEach((k, i) => {
      if (oldOauth[i] === undefined) delete process.env[k];
      else process.env[k] = oldOauth[i];
    });
    if (oldToken === undefined) delete process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
    else process.env.GOOGLE_ADS_DEVELOPER_TOKEN = oldToken;
  }
});
