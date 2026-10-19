import assert from 'node:assert/strict';
import test from 'node:test';
import { analyze } from '../lib/guard/analyze';
import { cleanName, times } from '../lib/guard/copy';
import { EMAIL_COPY } from '../lib/lifecycle/copy';
import { EMPTY_FACTS } from '../lib/lifecycle/types';
import { guardFactsFrom } from '../lib/guard/notify';
import type { GuardFinding } from '../lib/guard/types';
import { NOW, baseSignals, campaignInfo, campaignRows, flat } from './support/guard';

const HOUR = 3_600_000;
const BANNED = ['ليس مجرد', 'لا تفوت', 'المستوى التالي', 'بالإضافة إلى ذلك', 'علاوة على ذلك', 'من الجدير بالذكر', 'رحلتك', 'حلول متكاملة', 'هل تعاني', 'في النهاية', 'باختصار'];

/** Every code, every cause, so the house-style check reads all of our sentences. */
function everything(): GuardFinding[] {
  const conv = [...flat(0, 2), ...flat(2, 12)];
  const scenarios = [
    baseSignals({ googleStatus: 'SUSPENDED' }),
    baseSignals({ googleStatus: 'CANCELED' }),
    baseSignals({ googleStatus: 'CLOSED' }),
    baseSignals({ googleStatus: 'CUSTOMER_NOT_ENABLED' }),
    baseSignals({
      billing: {
        setupStatuses: ['CANCELLED'],
        budgets: [
          { name: 'a', status: 'APPROVED', limit: 1000, served: 1000, endsAt: null },
          { name: 'b', status: 'APPROVED', limit: 1000, served: 900, endsAt: null },
          { name: 'c', status: 'APPROVED', limit: null, served: 10, endsAt: NOW.getTime() + 2 * 86_400_000 },
        ],
      },
      daily: campaignRows('1', 'بحث — عام', { baseline: flat(100), yesterday: 0 }),
    }),
    baseSignals({ daily: [...campaignRows('1', 'بحث عام', { baseline: flat(100), yesterday: 0 }), ...campaignRows('2', 'ماركة', { baseline: flat(60), yesterday: 70 })] }),
    baseSignals({
      daily: [...campaignRows('1', 'بحث عام', { baseline: flat(100), yesterday: 0 }), ...campaignRows('2', 'ماركة', { baseline: flat(60), yesterday: 70 })],
      campaigns: [campaignInfo('1', 'بحث عام', { primaryReasons: ['CAMPAIGN_PAUSED'] })],
    }),
    baseSignals({
      daily: campaignRows('1', 'بحث عام', { baseline: flat(100), yesterday: 460 }),
      changes: [{ at: NOW.getTime() - 10 * HOUR, clientType: 'GOOGLE_ADS_WEB_CLIENT', resourceType: 'CAMPAIGN_BUDGET', operation: 'UPDATE', resourceName: 'customers/1/campaignBudgets/1', campaignId: '1', campaignName: 'بحث عام', fields: '' }],
    }),
    baseSignals({
      daily: campaignRows('1', 'بحث عام', { baseline: flat(100), conv, yesterday: 100, yesterdayConv: 0, yesterdayClicks: 30 }),
      changes: [{ at: NOW.getTime() - 10 * HOUR, clientType: 'GOOGLE_ADS_RECOMMENDATIONS', resourceType: 'CAMPAIGN_BUDGET', operation: 'UPDATE', resourceName: 'customers/1/campaignBudgets/1', campaignId: '1', campaignName: 'بحث عام', fields: '' }],
    }),
    baseSignals({
      daily: campaignRows('1', 'بحث عام', { baseline: flat(100), conv: flat(2), yesterday: 100, yesterdayConv: 1 }),
      campaigns: [campaignInfo('1', 'بحث عام', { budgetLostIs: 0.4 })],
    }),
    baseSignals({
      daily: campaignRows('1', 'بحث عام', { baseline: flat(100), conv: flat(2), yesterday: 100, yesterdayConv: 1 }),
      campaigns: [campaignInfo('1', 'بحث عام', { primaryReasons: ['BIDDING_STRATEGY_LEARNING'] })],
    }),
    baseSignals({
      daily: campaignRows('1', 'بحث عام', { baseline: flat(100), conv: flat(2), yesterday: 100, yesterdayConv: 1 }),
      campaigns: [campaignInfo('1', 'بحث عام', { rankLostIs: 0.5 })],
    }),
    baseSignals({
      daily: campaignRows('1', 'بحث عام', { baseline: flat(100), conv: flat(2), yesterday: 100, yesterdayConv: 1 }),
      campaigns: [campaignInfo('1', 'بحث عام', { impressionShare: 0.2, baselineImpressionShare: 0.6 })],
      ads: [
        { adId: '1', campaignId: '1', campaignName: 'بحث عام', approval: 'DISAPPROVED', topics: ['DESTINATION_NOT_WORKING', 'X'] },
        { adId: '2', campaignId: '1', campaignName: 'بحث عام', approval: 'APPROVED_LIMITED', topics: ['TRADEMARKS'] },
      ],
    }),
    baseSignals({
      changes: [
        { at: NOW.getTime() - 5 * HOUR, clientType: 'GOOGLE_ADS_WEB_CLIENT', resourceType: 'AD_GROUP_AD', operation: 'REMOVE', resourceName: 'a', campaignId: null, campaignName: null, fields: '' },
        { at: NOW.getTime() - 5 * HOUR, clientType: 'GOOGLE_ADS_SCRIPTS', resourceType: 'CAMPAIGN', operation: 'UPDATE', resourceName: 'b', campaignId: null, campaignName: null, fields: '' },
      ],
    }),
  ];
  return scenarios.flatMap((signals) => analyze(signals));
}

function lines(finding: GuardFinding): string[] {
  const cause = finding.cause;
  return [finding.whatAr, finding.stepAr, cause?.labelAr ?? '', cause?.stepAr ?? ''];
}

test('house style: no long dash, no Latin comma beside Arabic, no stock phrases, Latin digits, in every sentence', () => {
  const findings = everything();
  const codes = new Set(findings.map((f) => f.code));
  for (const code of ['account_status', 'billing_setup', 'billing_budget', 'spend_zero', 'spend_spike', 'cpa_spike', 'conversions_zero', 'ad_policy', 'outside_change']) {
    assert.ok(codes.has(code as any), `scenario covers ${code}`);
  }
  const causes = new Set(findings.map((f) => f.cause?.code).filter(Boolean));
  for (const cause of ['billing', 'campaign_state', 'tracking', 'recent_change', 'budget_limit', 'bidding', 'disapproval', 'auction']) {
    assert.ok(causes.has(cause as any), `scenario covers cause ${cause}`);
  }
  for (const finding of findings) {
    for (const line of lines(finding)) {
      assert.doesNotMatch(line, /[—–]/, line);
      assert.doesNotMatch(line.replace(/(\d),(\d)/g, '$1$2'), /[؀-ۿ][^\n]*,|,[^\n]*[؀-ۿ]/, line);
      assert.doesNotMatch(line, /[٠-٩]/, line);
      assert.doesNotMatch(line, /undefined|NaN|null/, line);
      for (const phrase of BANNED) assert.ok(!line.includes(phrase), `${phrase} in: ${line}`);
    }
    assert.ok(finding.whatAr.length > 10 && finding.stepAr.length > 10);
  }
});

test('house style: the email built from those findings is clean too', () => {
  const rows = everything().map((f, i) => ({
    id: String(i),
    account_id: 'a',
    code: f.code,
    dedupe_key: f.dedupeKey,
    severity: f.severity,
    status: 'open' as const,
    first_seen_at: NOW.toISOString(),
    last_seen_at: NOW.toISOString(),
    seen_count: 1,
    notified_at: null,
    what_ar: f.whatAr,
    step_ar: f.stepAr,
    evidence: f.evidence,
    cause: f.cause as any,
    escalation: f.escalation,
    entity_name: f.entityName,
  }));
  const guard = guardFactsFrom(rows, true)!;
  const mail = EMAIL_COPY.guard_alert.build({ ...EMPTY_FACTS, guard })!;
  const text = [mail.subject, mail.preheader, ...mail.blocks.flatMap((b) => (b.type === 'list' ? b.items : b.type === 'stat' ? [b.label, b.value] : [b.text]))];
  for (const line of text) {
    assert.doesNotMatch(line, /[—–]/, line);
    assert.doesNotMatch(line.replace(/(\d),(\d)/g, '$1$2'), /[؀-ۿ][^\n]*,|,[^\n]*[؀-ۿ]/, line);
    for (const phrase of BANNED) assert.ok(!line.includes(phrase), phrase);
  }
});

test('names from the merchant are bounded and lose long dashes before they reach a sentence', () => {
  assert.equal(cleanName('بحث — عام\nجديد'), 'بحث - عام جديد');
  assert.ok(cleanName('ا'.repeat(100)).length <= 43);
  const findings = analyze(baseSignals({ daily: campaignRows('1', 'بحث — عام', { baseline: flat(100), yesterday: 0 }), ads: [] }));
  assert.ok(findings.every((f) => !/[—–]/.test(f.whatAr)));
});

test('numbers in the sentences come from the evidence', () => {
  assert.equal(times(2), '2 ضعف');
  assert.equal(times(2.46), '2.5 ضعف');
  const spike = analyze(baseSignals({ daily: campaignRows('1', 'a', { baseline: flat(100), yesterday: 250 }) })).find((f) => f.code === 'spend_spike')!;
  assert.match(spike.whatAr, /250/);
  assert.match(spike.whatAr, /2.5 ضعف/);
  assert.equal(spike.evidence.ratio, 2.5);
});
