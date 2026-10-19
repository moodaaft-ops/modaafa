import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MONTHLY_MAX_OUTPUT_TOKENS,
  MONTHLY_SYSTEM_PROMPT,
  belowMinimumSpend,
  buildMoneyReport,
  cleanArabicLine,
  isGrounded,
  isReviewDay,
  monthlyLimits,
  moneyReportLines,
  numbersIn,
  parseMonthlyPlan,
  previousMonthWindow,
  protectedFromOutcomes,
  withinCostCap,
  worstCaseCostUsd,
  type MonthlyPack,
} from '../lib/loops/monthly';
import {
  reviewAccount,
  runMonthlyReview,
  type MonthlyAccount,
  type MonthlyDeps,
} from '../lib/loops/monthly-run';
import { EMAIL_COPY } from '../lib/lifecycle/copy';
import { COPY_KEYS } from '../lib/lifecycle/types';
import type { OutcomeRecord } from '../lib/loops/outcome-memory';

const ENV_ON = { MONTHLY_REVIEW_ENABLED: 'true' };
const NOW = new Date('2026-10-01T05:31:00Z');

test('the reviewed month is the one that just ended, in Riyadh time', () => {
  const w = previousMonthWindow(NOW);
  assert.deepEqual(w, { month: '2026-09', from: '2026-09-01', to: '2026-09-30', prior_from: '2026-08-01', prior_to: '2026-08-31' });
  // 22:00 UTC on 30 Sept is already 1 Oct in Riyadh.
  assert.equal(previousMonthWindow(new Date('2026-09-30T22:00:00Z')).month, '2026-09');
  assert.equal(previousMonthWindow(new Date('2027-01-02T09:00:00Z')).month, '2026-12');
  assert.equal(previousMonthWindow(new Date('2026-03-01T09:00:00Z')).to, '2026-02-28');
});

test('the review runs on the first days of the month only', () => {
  assert.equal(isReviewDay(new Date('2026-10-01T05:31:00Z')), true);
  assert.equal(isReviewDay(new Date('2026-10-03T05:31:00Z')), true);
  assert.equal(isReviewDay(new Date('2026-10-04T05:31:00Z')), false);
  assert.equal(isReviewDay(new Date('2026-10-19T05:31:00Z')), false);
});

test('limits come from the environment with safe defaults', () => {
  assert.deepEqual(monthlyLimits({}), { minSpend: 500, maxCostUsd: 0.5, maxAccounts: 25, catchupDays: 3 });
  assert.equal(monthlyLimits({ MONTHLY_REVIEW_MAX_COST_USD: '0.1' }).maxCostUsd, 0.1);
  assert.equal(monthlyLimits({ MONTHLY_REVIEW_MAX_COST_USD: 'abc' }).maxCostUsd, 0.5);
  assert.equal(monthlyLimits({ MONTHLY_REVIEW_MIN_SPEND: '-5' }).minSpend, 500);
  assert.equal(belowMinimumSpend(120, 500), true);
  assert.equal(belowMinimumSpend(500, 500), false);
  assert.equal(belowMinimumSpend(Number.NaN, 500), true);
});

test('cost cap is checked from a worst case bound before the call', () => {
  const model = 'claude-opus-5-5';
  const prompt = 'x'.repeat(12_000);
  const worst = worstCaseCostUsd(model, prompt, MONTHLY_MAX_OUTPUT_TOKENS);
  assert.ok(worst > 0 && worst < 0.2, String(worst));
  assert.equal(withinCostCap(model, prompt, MONTHLY_MAX_OUTPUT_TOKENS, 0.5).ok, true);
  assert.equal(withinCostCap(model, prompt, MONTHLY_MAX_OUTPUT_TOKENS, 0.01).ok, false);
  // a bigger prompt costs more
  assert.ok(worstCaseCostUsd(model, 'x'.repeat(60_000), 100) > worstCaseCostUsd(model, 'x'.repeat(6_000), 100));
});

const rec = (over: Partial<OutcomeRecord>): OutcomeRecord => ({
  action_id: 'a',
  action_type: 'add_negative_keyword',
  direction: null,
  entity: 'e',
  created_at: '2026-09-10T00:00:00Z',
  verdict: 'positive',
  confidence: 'medium',
  reason_ar: 'x',
  before: { cost: 200, clicks: 100, conversions: 10, conversion_value: 0 },
  after: { cost: 150, clicks: 80, conversions: 10, conversion_value: 0 },
  ...over,
});

test('protected money counts only measured changes of the month that kept their conversions', () => {
  const w = { from: '2026-09-01', to: '2026-09-30' };
  assert.deepEqual(protectedFromOutcomes([rec({})], w), { amount: 50, actions: 1 });
  assert.deepEqual(protectedFromOutcomes([rec({ verdict: 'negative' })], w), { amount: 0, actions: 0 });
  assert.deepEqual(protectedFromOutcomes([rec({ verdict: 'unknown' })], w), { amount: 0, actions: 0 });
  assert.deepEqual(protectedFromOutcomes([rec({ created_at: '2026-08-10T00:00:00Z' })], w), { amount: 0, actions: 0 });
  assert.deepEqual(protectedFromOutcomes([rec({ after: { cost: 100, clicks: 10, conversions: 5, conversion_value: 0 } })], w), { amount: 0, actions: 0 });
  assert.deepEqual(protectedFromOutcomes([rec({ before: null })], w), { amount: 0, actions: 0 });
});

test('the money report: four numbers from data, honest when one is unknown', () => {
  const full = buildMoneyReport({
    month: '2026-09',
    currency: 'SAR',
    current: { cost: 3200, conversions: 40, conversion_value: 14000 },
    prior: { cost: 3000, conversions: 30, conversion_value: 9000 },
    wasted: 410,
    protectedOutcome: { amount: 180, actions: 2 },
  });
  const text = moneyReportLines(full).join('\n');
  assert.match(text, /3,200 ريال/);
  assert.match(text, /14,000 ريال/);
  assert.match(text, /410 ريال/);
  assert.match(text, /180 ريال/);
  assert.match(text, /سبتمبر/);

  const unknown = buildMoneyReport({
    month: '2026-09',
    currency: 'SAR',
    current: { cost: 3200, conversions: 0, conversion_value: 0 },
    prior: null,
    wasted: null,
    protectedOutcome: { amount: 0, actions: 0 },
  });
  assert.equal(unknown.returned, null);
  assert.equal(unknown.wasted, null);
  assert.equal(unknown.protected, null);
  const lines = moneyReportLines(unknown);
  assert.equal(lines.length, 4);
  for (const line of lines) {
    assert.doesNotMatch(line, /[—–]/);
    const punctuation = line.replace(/(\d),(\d)/g, '$1$2');
    assert.doesNotMatch(punctuation, /[؀-ۿ][^\n]*,|,[^\n]*[؀-ۿ]/, line);
  }
});

const PACK = {
  month: '2026-09',
  currency: 'SAR',
  money: { spent: 3200, wasted: 410 },
  economics: { allowable_cpa_cut: 80 },
} as unknown as MonthlyPack;

test('model text is cleaned to house style and any ungrounded number is dropped', () => {
  assert.equal(cleanArabicLine('الصرف — عالي, والتحويل قليل'), 'الصرف، عالي، والتحويل قليل');
  const allowed = numbersIn(JSON.stringify(PACK));
  assert.equal(isGrounded('الهدر 410 ريال', allowed), true);
  assert.equal(isGrounded('الهدر 999 ريال', allowed), false);
  const plan = parseMonthlyPlan(
    JSON.stringify({
      targets_ar: 'تكلفة التحويل ضمن الحد 80 ريال',
      structure_ar: ['فصل حملة العطور عن الهدايا', 'وفّر 777 ريال بالشهر'],
      competition_ar: 'ما فيه تغيير واضح',
      quality_ar: [],
      season_plan_ar: ['جهّز عروض الجمعة البيضاء من بدري'],
      experiments_ar: ['جرّب عنوان جديد، ونقيس النقرات'],
    }) + ' trailing',
    PACK
  );
  assert.equal(plan.targets_ar, 'تكلفة التحويل ضمن الحد 80 ريال');
  assert.deepEqual(plan.structure_ar, ['فصل حملة العطور عن الهدايا']);
  assert.equal(plan.season_plan_ar.length, 1);
  assert.equal(parseMonthlyPlan('not json', PACK).structure_ar.length, 0);
  assert.equal(parseMonthlyPlan('', PACK).targets_ar, null);
});

test('the system prompt keeps the house rules', () => {
  assert.match(MONTHLY_SYSTEM_PROMPT, /JSON/);
  assert.match(MONTHLY_SYSTEM_PROMPT, /ما تنفذ شي/);
});

// ---------------------------------------------------------------------------
// The whole review with every dependency faked
// ---------------------------------------------------------------------------

function account(id = 'acc1'): MonthlyAccount {
  return {
    id,
    customer_id: '1234567890',
    customer_name: 'متجر العطور',
    currency_code: 'SAR',
    business_id: 'b1',
    sector: 'ecommerce',
    primary_goal: 'sales',
    monthly_budget: 4000,
    owner: { id: 'u1', email: 'owner@example.com', name: 'سارة', messages_opt_out: false },
    customer: { query: async () => { throw new Error('the faked deps must not reach Google Ads'); } },
  };
}

function makeDeps(over: Partial<MonthlyDeps> = {}) {
  const calls = { model: 0, saved: [] as Array<Record<string, unknown>>, sent: [] as Array<{ money: string[]; plan: string[] }>, totals: 0 };
  const deps: MonthlyDeps = {
    readTotals: async () => {
      calls.totals += 1;
      return { cost: 3200, conversions: 40, conversion_value: 14000, campaigns: [{ name: 'عطور', cost: 3200, conversions: 40, value: 14000, cpa: 80 }] };
    },
    loadEconomics: async () => null,
    readNgram: async () => ({
      window_days: 30,
      terms_scanned: 10,
      spend_scanned: 3200,
      allowable_cpa: { value: 80, source: 'account_30d_cpa_fallback' },
      waste_threshold: 160,
      wasteful: [],
      wasteful_terms_cost: 410,
      winners: [],
      note: 'ok',
    }),
    readCompetition: async () => ({ source: 'unavailable', findings: [], share_trend: null, summary_ar: null, fallback_reason: null }),
    readQuality: async () => [],
    loadOutcomes: async () => [],
    loadMerchant: async () => null,
    hasReport: async () => false,
    saveReport: async (row) => (calls.saved.push(row), 'saved'),
    callModel: async () => {
      calls.model += 1;
      return {
        text: JSON.stringify({ targets_ar: 'تكلفة التحويل 80 ريال وهي ضمن الحد', structure_ar: ['افصل حملة العطور عن الهدايا'], experiments_ar: [] }),
        model: 'claude-opus-5-5',
        input_tokens: 3000,
        output_tokens: 600,
      };
    },
    send: async (_a, _w, money, plan) => (calls.sent.push({ money, plan }), { status: 'skipped', reason: 'not_approved' } as any),
    modelName: () => 'claude-opus-5-5',
    ...over,
  };
  return { deps, calls };
}

const run = (deps: MonthlyDeps, over: Partial<Parameters<typeof reviewAccount>[0]> = {}) =>
  reviewAccount({ account: account(), window: previousMonthWindow(NOW), now: NOW, limits: monthlyLimits({}), deps, env: ENV_ON, ...over });

test('a normal account gets one report, one Opus call, and a held mail', async () => {
  const { deps, calls } = makeDeps();
  const out = await run(deps);
  assert.equal(out.status, 'reported');
  assert.equal(calls.model, 1);
  assert.equal(calls.saved.length, 1);
  const row = calls.saved[0] as any;
  assert.equal(row.period_type, 'monthly');
  assert.equal(row.period_start, '2026-09-01');
  assert.equal(row.metrics.money.wasted, 410);
  assert.equal(row.metrics.plan.targets_ar, 'تكلفة التحويل 80 ريال وهي ضمن الحد');
  assert.ok(calls.sent[0].money.length === 4);
  assert.equal((out as any).mail, 'skipped');
  assert.ok((out as any).model_cost_usd > 0);
});

test('an account with a monthly report already is not touched again', async () => {
  const { deps, calls } = makeDeps({ hasReport: async () => true });
  const out = await run(deps);
  assert.deepEqual(out, { account_id: 'acc1', status: 'skipped', reason: 'already_reported' });
  assert.equal(calls.totals, 0);
  assert.equal(calls.model, 0);
});

test('tiny spend skips the account before any model call', async () => {
  const { deps, calls } = makeDeps({
    readTotals: async () => ({ cost: 120, conversions: 2, conversion_value: 0, campaigns: [] }),
  });
  const out = await run(deps);
  assert.deepEqual(out, { account_id: 'acc1', status: 'skipped', reason: 'below_min_spend' });
  assert.equal(calls.model, 0);
  assert.equal(calls.saved.length, 0);
});

test('a call that could exceed the cap is never made, but the money report is still stored', async () => {
  const { deps, calls } = makeDeps();
  const out = await run(deps, { limits: { ...monthlyLimits({}), maxCostUsd: 0.001 } });
  assert.equal(out.status, 'reported');
  assert.equal(calls.model, 0);
  assert.equal((calls.saved[0] as any).metrics.plan_status, 'skipped_cost_cap');
  assert.equal((calls.saved[0] as any).metrics.money.spent, 3200);
});

test('a model failure still stores the money report', async () => {
  const { deps, calls } = makeDeps({ callModel: async () => null });
  const out = await run(deps);
  assert.equal(out.status, 'reported');
  assert.equal((calls.saved[0] as any).metrics.plan_status, 'model_unavailable');
});

test('a read that throws is a failed account, not a crashed run', async () => {
  const { deps } = makeDeps({ readTotals: async () => { throw new Error('GOOGLE_DOWN'); } });
  const out = await run(deps);
  assert.equal(out.status, 'failed');
});

test('optional blocks are read only when their own switch is on', async () => {
  let outcomesRead = 0;
  let merchantRead = 0;
  const { deps } = makeDeps({
    loadOutcomes: async () => (outcomesRead += 1, []),
    loadMerchant: async () => (merchantRead += 1, null),
  });
  await run(deps);
  assert.equal(outcomesRead + merchantRead, 0);
  await run(deps, { env: { ...ENV_ON, OUTCOME_MEMORY_ENABLED: 'true', BUSINESS_MEMORY_ENABLED: 'true' } });
  assert.equal(outcomesRead, 1);
  assert.equal(merchantRead, 1);
});

test('flag off: the run does nothing at all', async () => {
  const { deps, calls } = makeDeps();
  let listed = 0;
  const summary = await runMonthlyReview({
    supabase: {},
    listAccounts: async () => (listed += 1, [account()]),
    deps,
    now: NOW,
    env: {},
  });
  assert.equal(summary.ran, false);
  assert.equal(summary.reason, 'disabled');
  assert.equal(listed, 0);
  assert.equal(calls.model, 0);
});

test('outside the first days of the month nothing runs, unless forced', async () => {
  const { deps, calls } = makeDeps();
  const mid = new Date('2026-10-19T05:31:00Z');
  const idle = await runMonthlyReview({ supabase: {}, listAccounts: async () => [account()], deps, now: mid, env: ENV_ON });
  assert.equal(idle.reason, 'not_review_day');
  assert.equal(calls.model, 0);
  const forced = await runMonthlyReview({ supabase: {}, listAccounts: async () => [account()], deps, now: mid, env: ENV_ON, force: true });
  assert.equal(forced.reported, 1);
  assert.equal(forced.model_calls, 1);
});

test('the summary adds up several accounts and respects the time budget', async () => {
  const { deps } = makeDeps();
  const accounts = [account('a'), account('b'), account('c')];
  const summary = await runMonthlyReview({ supabase: {}, listAccounts: async () => accounts, deps, now: NOW, env: ENV_ON });
  assert.equal(summary.considered, 3);
  assert.equal(summary.reported, 3);
  assert.ok(summary.model_cost_usd > 0);
  const stopped = await runMonthlyReview({ supabase: {}, listAccounts: async () => accounts, deps, now: NOW, env: ENV_ON, budgetMs: -1 });
  assert.equal(stopped.results.length, 0);
});

// ---------------------------------------------------------------------------
// The mail copy
// ---------------------------------------------------------------------------

test('the monthly copy exists, waits for Ayman, and stays in house style', () => {
  assert.ok((COPY_KEYS as readonly string[]).includes('monthly_report'));
  const copy = EMAIL_COPY.monthly_report;
  assert.equal(copy.approved, false);
  assert.equal(copy.build({ firstName: null, businessName: null, plan: null, trial: null, weekly: null, billing: null }), null);
  const built = copy.build({
    firstName: 'سارة',
    businessName: 'متجر',
    plan: null,
    trial: null,
    weekly: null,
    billing: null,
    monthly: { month: '2026-09', monthNameAr: 'سبتمبر', moneyLines: ['صرفت 3,200 ريال.'], planLines: ['افصل الحملة — الآن'] },
  })!;
  assert.match(built.subject, /سبتمبر/);
  assert.ok(built.subject.length <= 70 && built.preheader.length <= 90);
  const all = [built.subject, built.preheader, ...built.blocks.map((b) => ('text' in b ? b.text : b.type === 'list' ? b.items.join(' ') : ''))].join(' ');
  assert.doesNotMatch(all, /[—–]/);
});

test('review: the cost cap is priced at the priciest model the call can fall back to', async () => {
  const { priciestModel } = await import('../lib/loops/monthly-run');
  assert.equal(priciestModel(['claude-opus-5-5', 'claude-opus-4-1-20250805', 'claude-sonnet-5-5']), 'claude-opus-4-1-20250805');
  assert.equal(priciestModel(['claude-sonnet-5-5']), 'claude-sonnet-5-5');
});
