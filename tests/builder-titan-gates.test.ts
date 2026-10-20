import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BUILDER_SYSTEM_PROMPT,
  buildCampaign,
  runBuilderTool,
} from '../lib/ai/builder-agent';
import {
  FORECAST_UNAVAILABLE_REASON_AR,
  UNKNOWN_BUILDER_SIGNALS,
  allowedStrategies,
  applyBuilderGates,
  assistantDraftBidding,
  briefAsksForType,
  defaultStrategy,
  hasTargetBiddingVolume,
  isCpaStable,
  mentionsGuarantee,
  type BuilderAccountSignals,
} from '../lib/ai/builder-gates';
import { deriveBuilderSignals, loadBuilderSignals } from '../lib/ai/builder-signals';
import { getAnthropicClient } from '../lib/ai/client';

const signals = (overrides: Partial<BuilderAccountSignals> = {}): BuilderAccountSignals => ({
  conversions_30d: 12,
  tracking_healthy: true,
  merchant_center_linked: false,
  ...overrides,
});

const baseDraft = (overrides: Record<string, unknown> = {}) => ({
  name: 'حملة عطور',
  type: 'SEARCH',
  objective: 'SALES',
  daily_budget_sar: 100,
  bidding_strategy: 'MAXIMIZE_CONVERSIONS',
  geo_targets: [{ country: 'SA', regions: ['الرياض'] }],
  language: 'ar',
  ad_groups: [
    {
      name: 'عطور رجالية',
      keywords: [
        { text: 'عطر رجالي', match_type: 'BROAD' },
        { text: 'عطر عود', match_type: 'EXACT' },
        { text: 'عطر فاخر', match_type: 'PHRASE' },
      ],
      headlines_ar: ['عطور أصلية', 'ضمان الجودة', 'اطلب الآن'],
      descriptions_ar: ['شحن سريع لكل المدن', 'نضمن لك الرضا التام'],
    },
  ],
  forecast: { expected_clicks: 2000, expected_conversions: 50, expected_cpa_sar: 60, expected_roas: 3.5 },
  ...overrides,
});

// ---------------------------------------------------------------------------
// 1a. No fabricated forecast
// ---------------------------------------------------------------------------

test('forecast_campaign no longer returns invented numbers, only that no forecast is available', async () => {
  const result = await runBuilderTool('forecast_campaign', { keywords: ['عطر'], daily_budget_sar: 100 });
  assert.deepEqual(result, { available: false, reason_ar: FORECAST_UNAVAILABLE_REASON_AR });
  const text = JSON.stringify(result);
  assert.doesNotMatch(text, /expected_|4\.5|3\.5|0\.025/);
});

test('every draft carries an honest forecast block, whatever the model wrote', () => {
  const { draft } = applyBuilderGates(baseDraft(), { brief: 'عطور', signals: signals() });
  assert.deepEqual(draft.forecast, { available: false, reason_ar: FORECAST_UNAVAILABLE_REASON_AR });
  assert.equal(JSON.stringify(draft).includes('expected_roas'), false);
});

test('the builder prompt forbids invented numbers, advertises no forecast tool and contains no guarantee wording', () => {
  assert.doesNotMatch(BUILDER_SYSTEM_PROMPT, /expected_clicks|expected_conversions|expected_cpa|expected_roas/);
  assert.doesNotMatch(BUILDER_SYSTEM_PROMPT, /ضمان|نضمن|مضمون/);
  assert.match(BUILDER_SYSTEM_PROMPT, /NO INVENTED NUMBERS/);
  assert.match(BUILDER_SYSTEM_PROMPT, /30 conversions in 30 days/);
});

// ---------------------------------------------------------------------------
// 1b. Gates
// ---------------------------------------------------------------------------

test('bidding ladder: unknown or unhealthy tracking starts at Max Clicks with a CPC cap still owed', () => {
  for (const s of [UNKNOWN_BUILDER_SIGNALS, signals({ conversions_30d: 0, tracking_healthy: false })]) {
    const result = applyBuilderGates(baseDraft(), { brief: 'عطور', signals: s });
    assert.equal(result.draft.bidding_strategy, 'MAXIMIZE_CLICKS');
    assert.equal(result.draft.max_cpc_sar, null);
    assert.ok(result.draft.missing_inputs_ar.some((item: string) => item.includes('سقف سعر النقرة')));
    assert.ok(result.changes.some((change) => change.rule === 'bidding'));
  }
});

test('bidding ladder: Max Clicks keeps a cap the model gave and warns when it is above a tenth of the budget', () => {
  const ok = applyBuilderGates(baseDraft({ bidding_strategy: 'MAXIMIZE_CLICKS', max_cpc_sar: 5 }), {
    brief: 'عطور',
    signals: UNKNOWN_BUILDER_SIGNALS,
  });
  assert.equal(ok.draft.max_cpc_sar, 5);
  assert.equal(ok.changes.some((change) => change.rule === 'cpc_cap_missing' || change.rule === 'cpc_cap_high'), false);

  const high = applyBuilderGates(baseDraft({ bidding_strategy: 'MAXIMIZE_CLICKS', max_cpc_sar: 30 }), {
    brief: 'عطور',
    signals: UNKNOWN_BUILDER_SIGNALS,
  });
  assert.equal(high.draft.max_cpc_sar, 30);
  assert.ok(high.changes.some((change) => change.rule === 'cpc_cap_high'));
});

test('bidding ladder: Max Conversions only when tracking is healthy, and it carries no CPC cap', () => {
  const healthy = applyBuilderGates(baseDraft({ max_cpc_sar: 4 }), { brief: 'عطور', signals: signals({ conversions_30d: 12 }) });
  assert.equal(healthy.draft.bidding_strategy, 'MAXIMIZE_CONVERSIONS');
  assert.equal('max_cpc_sar' in healthy.draft, false);

  const unhealthy = applyBuilderGates(baseDraft(), { brief: 'عطور', signals: signals({ conversions_30d: 12, tracking_healthy: false }) });
  assert.equal(unhealthy.draft.bidding_strategy, 'MAXIMIZE_CLICKS');
});

test('bidding ladder: TARGET_CPA and TARGET_ROAS are refused below 30 conversions in 30 days', () => {
  for (const strategy of ['TARGET_CPA', 'TARGET_ROAS', 'MAXIMIZE_CONVERSIONS_WITH_TARGET_CPA']) {
    const result = applyBuilderGates(baseDraft({ bidding_strategy: strategy }), {
      brief: 'عطور',
      signals: signals({ conversions_30d: 29 }),
    });
    assert.equal(result.draft.bidding_strategy, 'MAXIMIZE_CONVERSIONS', strategy);
  }
  assert.equal(hasTargetBiddingVolume(29), false);
  assert.equal(hasTargetBiddingVolume(30), true);
});

test('bidding ladder: at 30 conversions a target strategy is allowed but never with a number from the builder', () => {
  const result = applyBuilderGates(
    baseDraft({ bidding_strategy: 'TARGET_CPA', target_cpa_sar: 45, target_roas: 4 }),
    { brief: 'عطور', signals: signals({ conversions_30d: 30 }) }
  );
  assert.equal(result.draft.bidding_strategy, 'TARGET_CPA');
  assert.equal('target_cpa_sar' in result.draft, false);
  assert.equal('target_roas' in result.draft, false);
  assert.equal(result.draft.target_value_sar, null);
  assert.ok(result.draft.missing_inputs_ar.some((item: string) => item.includes('هامشك')));
  assert.match(result.draft.bidding_note_ar, /هامش ربحك ونسبة إغلاق/);
});

test('bidding ladder: TARGET_ROAS is for sales only, a lead draft falls back to the default', () => {
  const lead = applyBuilderGates(baseDraft({ objective: 'LEADS', bidding_strategy: 'TARGET_ROAS' }), {
    brief: 'عيادة',
    signals: signals({ conversions_30d: 60 }),
  });
  assert.equal(lead.draft.bidding_strategy, 'MAXIMIZE_CONVERSIONS');
  assert.equal(allowedStrategies(signals({ conversions_30d: 60 }), 'LEADS').includes('TARGET_ROAS'), false);
  assert.equal(allowedStrategies(signals({ conversions_30d: 60 }), 'SALES').includes('TARGET_ROAS'), true);
});

test('BROAD match is downgraded to PHRASE unless a target strategy runs on 30 conversions', () => {
  const keywords = (result: ReturnType<typeof applyBuilderGates>) =>
    result.draft.ad_groups[0].keywords.map((keyword: { match_type: string }) => keyword.match_type);

  const maxConversions = applyBuilderGates(baseDraft(), { brief: 'عطور', signals: signals({ conversions_30d: 12 }) });
  assert.deepEqual(keywords(maxConversions), ['PHRASE', 'EXACT', 'PHRASE']);
  assert.ok(maxConversions.changes.some((change) => change.rule === 'broad_match'));

  const unknown = applyBuilderGates(baseDraft(), { brief: 'عطور', signals: UNKNOWN_BUILDER_SIGNALS });
  assert.deepEqual(keywords(unknown), ['PHRASE', 'EXACT', 'PHRASE']);

  const target = applyBuilderGates(baseDraft({ bidding_strategy: 'TARGET_CPA' }), {
    brief: 'عطور',
    signals: signals({ conversions_30d: 45 }),
  });
  assert.deepEqual(keywords(target), ['BROAD', 'EXACT', 'PHRASE']);
});

test('a keyword with no or an unknown match type defaults to PHRASE, and plain strings are kept', () => {
  const draft = baseDraft();
  draft.ad_groups[0].keywords = [{ text: 'أ' }, { text: 'ب', match_type: 'weird' }, 'ج' as any];
  const result = applyBuilderGates(draft, { brief: 'عطور', signals: signals() });
  assert.deepEqual(
    result.draft.ad_groups[0].keywords.map((keyword: any) => [keyword.text, keyword.match_type]),
    [['أ', 'PHRASE'], ['ب', 'PHRASE'], ['ج', 'PHRASE']]
  );
});

test('PMax: never for lead generation, whatever the account looks like', () => {
  const result = applyBuilderGates(baseDraft({ type: 'PMAX', objective: 'LEADS' }), {
    brief: 'عيادة أسنان',
    signals: signals({ conversions_30d: 200, merchant_center_linked: true }),
  });
  assert.equal(result.draft.type, 'SEARCH');
  assert.ok(result.changes.some((change) => change.rule === 'pmax_leads'));
  assert.match(result.notes_ar.join(' '), /أوفلاين/);
});

test('PMax for a store needs a Merchant Center feed, then 30 conversions; otherwise Search or Standard Shopping', () => {
  const type = (s: BuilderAccountSignals, requested = 'PMAX') =>
    applyBuilderGates(baseDraft({ type: requested }), { brief: 'متجر عطور', signals: s }).draft.type;

  assert.equal(type(signals({ conversions_30d: 80, merchant_center_linked: false })), 'SEARCH');
  assert.equal(type(signals({ conversions_30d: 80, merchant_center_linked: null })), 'SEARCH');
  assert.equal(type(signals({ conversions_30d: 29, merchant_center_linked: true })), 'SHOPPING');
  assert.equal(type(signals({ conversions_30d: null, merchant_center_linked: true })), 'SHOPPING');
  assert.equal(type(signals({ conversions_30d: 30, merchant_center_linked: true })), 'PMAX');
});

test('Shopping needs a Merchant Center feed, otherwise the draft becomes a Search campaign', () => {
  assert.equal(
    applyBuilderGates(baseDraft({ type: 'SHOPPING' }), { brief: 'متجر', signals: signals({ merchant_center_linked: false }) }).draft.type,
    'SEARCH'
  );
  assert.equal(
    applyBuilderGates(baseDraft({ type: 'SHOPPING' }), { brief: 'متجر', signals: signals({ merchant_center_linked: true }) }).draft.type,
    'SHOPPING'
  );
});

test('Display and Video are proposed only when the brief explicitly asked for them', () => {
  const gate = (type: string, brief: string) =>
    applyBuilderGates(baseDraft({ type }), { brief, signals: signals() }).draft.type;

  assert.equal(gate('DISPLAY', 'أبغى حملة لمنتج عطر رجالي بميزانية 3000'), 'SEARCH');
  assert.equal(gate('VIDEO', 'أبغى حملة لمنتج عطر رجالي بميزانية 3000'), 'SEARCH');
  assert.equal(gate('DISPLAY', 'ابغى حملة ديسبلاي بانرات للعطور'), 'DISPLAY');
  assert.equal(gate('VIDEO', 'ابغى حملة فيديو على يوتيوب'), 'VIDEO');
  assert.equal(gate('DEMAND_GEN', 'ابغى حملة جديدة'), 'SEARCH');
  assert.equal(briefAsksForType('Run a YouTube campaign', 'VIDEO'), true);
  assert.equal(briefAsksForType('Run a search campaign', 'DISPLAY'), false);
});

test('Search campaigns launch with Search Partners and the Display Network off, in PRESENCE, and PAUSED', () => {
  const result = applyBuilderGates(
    baseDraft({
      network_settings: { search_partners: true, display_network: true },
      location_option: 'PRESENCE_OR_INTEREST',
      status: 'ENABLED',
      approval_required: false,
    }),
    { brief: 'عطور', signals: signals() }
  );
  assert.deepEqual(result.draft.network_settings, { search_partners: false, display_network: false });
  assert.equal(result.draft.location_option, 'PRESENCE', 'no reason given, so presence only');
  assert.equal(result.draft.status, 'PAUSED');
  assert.equal(result.draft.approval_required, true);
});

test('PRESENCE_OR_INTEREST survives only with a stated reason', () => {
  const result = applyBuilderGates(
    baseDraft({ location_option: 'PRESENCE_OR_INTEREST', location_option_reason_ar: 'المشتري مقيم خارج المملكة ويطلب أضحية تُذبح هنا' }),
    { brief: 'أضاحي', signals: signals() }
  );
  assert.equal(result.draft.location_option, 'PRESENCE_OR_INTEREST');
});

test('the gates do not mutate the model draft and tolerate garbage', () => {
  const draft = baseDraft();
  const snapshot = JSON.stringify(draft);
  applyBuilderGates(draft, { brief: 'عطور', signals: signals() });
  assert.equal(JSON.stringify(draft), snapshot);

  for (const garbage of [null, undefined, 'نص', 42, [], {}]) {
    const result = applyBuilderGates(garbage, { brief: '', signals: undefined });
    assert.equal(result.draft.status, 'PAUSED');
    assert.equal(result.draft.type, 'SEARCH');
    assert.equal(result.draft.bidding_strategy, 'MAXIMIZE_CLICKS');
  }
});

// ---------------------------------------------------------------------------
// 1c. Guarantee wording
// ---------------------------------------------------------------------------

test('guarantee wording is removed from ad copy unless the merchant wrote it in the brief', () => {
  const stripped = applyBuilderGates(baseDraft(), { brief: 'أبغى حملة عطور', signals: signals() });
  const group = stripped.draft.ad_groups[0];
  assert.deepEqual(group.headlines_ar, ['عطور أصلية', 'اطلب الآن']);
  assert.deepEqual(group.descriptions_ar, ['شحن سريع لكل المدن']);
  assert.ok(stripped.changes.some((change) => change.rule === 'guarantee_copy'));

  const kept = applyBuilderGates(baseDraft(), { brief: 'عطور مع ضمان سنتين من الشركة', signals: signals() });
  assert.equal(kept.draft.ad_groups[0].headlines_ar.length, 3);

  assert.equal(mentionsGuarantee('ضمان استرجاع'), true);
  assert.equal(mentionsGuarantee('نضمن لك النتيجة'), true);
  assert.equal(mentionsGuarantee('100% guaranteed'), true);
  assert.equal(mentionsGuarantee('شحن مجاني'), false);
});

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

test('default strategy follows tracking, not a fixed value', () => {
  assert.equal(defaultStrategy(UNKNOWN_BUILDER_SIGNALS), 'MAXIMIZE_CLICKS');
  assert.equal(defaultStrategy(signals({ conversions_30d: 0, tracking_healthy: false })), 'MAXIMIZE_CLICKS');
  assert.equal(defaultStrategy(signals({ conversions_30d: 3 })), 'MAXIMIZE_CLICKS');
  assert.equal(defaultStrategy(signals({ conversions_30d: 10 })), 'MAXIMIZE_CONVERSIONS');
});

test('signals: conversions come from the synced cache, tracking is healthy only if conversions arrive and nothing contradicts it', () => {
  const cacheRows = [{ metrics_30d: { conversions: 10 } }, { metrics_30d: { conversions: 5.5 } }, { metrics_30d: null }];
  assert.deepEqual(deriveBuilderSignals({ cacheRows, stored: null }), {
    conversions_30d: 15.5,
    tracking_healthy: true,
    merchant_center_linked: null,
  });
  assert.deepEqual(deriveBuilderSignals({ cacheRows: [], stored: null }), UNKNOWN_BUILDER_SIGNALS);
  assert.deepEqual(deriveBuilderSignals({ cacheRows: [{ metrics_30d: { conversions: 0 } }], stored: null }), {
    conversions_30d: 0,
    tracking_healthy: false,
    merchant_center_linked: null,
  });

  const stored = {
    version: 1,
    campaigns: { ok: true, value: [{ conversions30: 4 }, { conversions30: 6 }] },
    enabledConversionActions: { ok: true, value: 0 },
    autoTagging: { ok: true, value: true },
    merchantCenterLinked: { ok: true, value: true },
  } as any;
  assert.deepEqual(deriveBuilderSignals({ cacheRows: null, stored }), {
    conversions_30d: 10,
    tracking_healthy: false,
    merchant_center_linked: true,
  });
  assert.equal(
    deriveBuilderSignals({ cacheRows, stored: { ...stored, enabledConversionActions: { ok: true, value: 2 }, autoTagging: { ok: true, value: false } } })
      .tracking_healthy,
    false
  );
  assert.equal(
    deriveBuilderSignals({ cacheRows, stored: { ...stored, enabledConversionActions: { ok: false }, autoTagging: { ok: false } } }).tracking_healthy,
    true,
    'a signal that failed to read does not contradict arriving conversions'
  );
});

test('loadBuilderSignals never throws: a broken read is unknown', async () => {
  const broken = {
    from() {
      throw new Error('db down');
    },
  };
  assert.deepEqual(await loadBuilderSignals({ supabase: broken, admin: null, accountId: 'x' }), UNKNOWN_BUILDER_SIGNALS);

  const supabase = {
    from: () => ({ select: () => ({ eq: () => ({ limit: async () => ({ data: [{ metrics_30d: { conversions: 7 } }], error: null }) }) }) }),
  };
  const read = await loadBuilderSignals({ supabase, admin: null, accountId: 'x' });
  assert.equal(read.conversions_30d, 7);
  assert.equal(read.tracking_healthy, true);
});

// ---------------------------------------------------------------------------
// The gates run when the builder finalizes a draft
// ---------------------------------------------------------------------------

test('buildCampaign forces the model draft through the gates when it finalizes', async () => {
  const saved = {
    key: process.env.ANTHROPIC_API_KEY,
    url: process.env.NEXT_PUBLIC_SUPABASE_URL,
    service: process.env.SUPABASE_SERVICE_ROLE_KEY,
    fetch: globalThis.fetch,
    error: console.error,
  };
  process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key-not-real';
  globalThis.fetch = (async (input: any) => {
    const url = String(typeof input === 'string' ? input : input?.url ?? input);
    if (url.includes('/rest/v1/llm_usage')) return new Response(null, { status: 201 });
    throw new Error('network disabled in test');
  }) as typeof fetch;
  console.error = () => {};

  const anthropic = getAnthropicClient() as any;
  const originalCreate = anthropic.messages.create;
  const prompts: string[] = [];
  anthropic.messages.create = async (params: any) => {
    prompts.push(String(params.messages[0].content));
    return {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: params.model,
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'finalize_draft',
          input: {
            draft: baseDraft({ type: 'PMAX', bidding_strategy: 'TARGET_ROAS', network_settings: { search_partners: true } }),
            summary_ar: 'مسودة حملة عطور',
            next_steps_ar: ['أكد الميزانية'],
          },
        },
      ],
      usage: { input_tokens: 10, output_tokens: 10 },
    };
  };

  try {
    const result = await buildCampaign('أبغى حملة عطور', {} as any, { business_name: 'متجر', signals: signals({ conversions_30d: 8 }) });
    const draft = result.draft_campaign;
    assert.equal(draft.type, 'SEARCH', 'no Merchant Center feed, so PMax becomes Search');
    assert.equal(draft.bidding_strategy, 'MAXIMIZE_CLICKS', '8 conversions: below the owner floor');
    assert.deepEqual(draft.network_settings, { search_partners: false, display_network: false });
    assert.equal(draft.status, 'PAUSED');
    assert.deepEqual(draft.forecast, { available: false, reason_ar: FORECAST_UNAVAILABLE_REASON_AR });
    assert.equal(
      draft.ad_groups[0].keywords.every((keyword: any) => keyword.match_type !== 'BROAD'),
      true
    );
    assert.equal(JSON.stringify(draft).includes('ضمان'), false);
    assert.equal(result.next_steps_ar[0], 'أكد الميزانية');
    assert.ok(result.next_steps_ar.length > 1, 'the gate notes are appended for the owner');
    // The model sees the account facts it must respect.
    assert.match(prompts[0], /"account_signals":\{"conversions_30d":8,"tracking_healthy":true,"merchant_center_linked":false\}/);
  } finally {
    anthropic.messages.create = originalCreate;
    globalThis.fetch = saved.fetch;
    console.error = saved.error;
    for (const [name, value] of [
      ['ANTHROPIC_API_KEY', saved.key],
      ['NEXT_PUBLIC_SUPABASE_URL', saved.url],
      ['SUPABASE_SERVICE_ROLE_KEY', saved.service],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('the placeholder draft (no AI backend) follows the same gates and promises no forecast', async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const result = await buildCampaign('أبغى حملة', {} as any, { business_name: 'متجر' });
    assert.equal(result.draft_campaign.bidding_strategy, 'MAXIMIZE_CLICKS');
    assert.equal(result.draft_campaign.status, 'PAUSED');
    assert.equal(result.draft_campaign.needs_ai_enrichment, true);
    assert.deepEqual(result.draft_campaign.forecast, { available: false, reason_ar: FORECAST_UNAVAILABLE_REASON_AR });
    assert.doesNotMatch(JSON.stringify(result), /التوقعات|expected_/);
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  }
});

// ---------------------------------------------------------------------------
// 4. The assistant's draft (shared rule)
// ---------------------------------------------------------------------------

test('assistant draft: target CPA needs 30 conversions in 30 days AND a stable CPA, not 15 in 7 days', () => {
  assert.equal(assistantDraftBidding({ conversions30d: 15, cpaDeltaPct: 0 }).strategy, 'MAXIMIZE_CONVERSIONS');
  assert.equal(assistantDraftBidding({ conversions30d: 29, cpaDeltaPct: 5 }).strategy, 'MAXIMIZE_CONVERSIONS');
  assert.equal(assistantDraftBidding({ conversions30d: 45, cpaDeltaPct: 35 }).strategy, 'MAXIMIZE_CONVERSIONS', 'unstable CPA');
  assert.equal(assistantDraftBidding({ conversions30d: 45, cpaDeltaPct: -35 }).strategy, 'MAXIMIZE_CONVERSIONS', 'unstable CPA');
  assert.equal(assistantDraftBidding({ conversions30d: 45, cpaDeltaPct: null }).strategy, 'MAXIMIZE_CONVERSIONS', 'unknown CPA trend');
  const ready = assistantDraftBidding({ conversions30d: 30, cpaDeltaPct: 20 });
  assert.equal(ready.strategy, 'TARGET_CPA');
  assert.equal(ready.needs_target_from_economics, true);
  assert.match(ready.note_ar, /هامش ربحك ونسبة إغلاق/);
  assert.equal(assistantDraftBidding({ conversions30d: 0, cpaDeltaPct: null }).strategy, 'MAXIMIZE_CLICKS');
  assert.equal(isCpaStable(20), true);
  assert.equal(isCpaStable(20.1), false);
});

test('the assistant route builds its draft with the shared bidding rule and tells the model targets come from the merchant', async () => {
  const { readFileSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const route = readFileSync(resolve('app/api/chat/assistant/route.ts'), 'utf8');
  assert.match(route, /assistantDraftBidding\(/);
  assert.doesNotMatch(route, /recent_7d\.conversions\s*>=\s*15/);
  assert.doesNotMatch(route, /MAXIMIZE_CONVERSIONS_WITH_TARGET_CPA/);
  assert.match(route, /30 تحويلاً أو أكثر في آخر 30 يوماً/);
  assert.match(route, /هامش التاجر ونسبة إغلاقه/);
});
