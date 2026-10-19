import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLoserPauseCards, loserCardToRow, loserPauseFingerprint, LOSER_CARD_TITLE_AR, queueLoserPauseCards } from '../lib/ads/ad-test-cards';
import { evaluateAdTest, type AdTestResult } from '../lib/ads/ad-test';
import { buildExecutableAction } from '../lib/ai/executable-action';
import { disapprovalFindings, buildAppealText, policyTopicLabelAr } from '../lib/ads/disapproved';
import { buildAssetProposals, cardToRow } from '../lib/ads/proposals';
import { normalizeRsaRows } from '../lib/ads/assets-reader';

const CID = '1234567890';
const A = `customers/${CID}/adGroupAds/11~22`;
const B = `customers/${CID}/adGroupAds/11~33`;
const GROUP = `customers/${CID}/adGroups/11`;
const CAMPAIGN = `customers/${CID}/campaigns/555`;

function winnerTest(): AdTestResult {
  const verdict = evaluateAdTest(
    { ad_group_ad: A, impressions: 6000, clicks: 300, conversions: 60, cost: 900 },
    { ad_group_ad: B, impressions: 6000, clicks: 300, conversions: 20, cost: 900 },
    28
  );
  return { ad_group: GROUP, ad_group_name: 'قص وتصفيف', ads: [A, B], verdict };
}

// ---- item 3 ---------------------------------------------------------------
test('ad test: a winner makes ONE "pause the loser" card with the base pause_ad shape', async () => {
  const t = winnerTest();
  assert.equal(t.verdict.status, 'winner');
  const out = await buildLoserPauseCards({ accountId: 'acc', customerId: CID, tests: [t], trackingStatus: 'healthy', hasBlocking: async () => false });
  assert.equal(out.cards.length, 1);
  const card = out.cards[0];
  assert.equal(card.action.type, 'pause_ad');
  assert.equal(card.action.target_id, B, 'the loser, never the winner');
  assert.equal(card.fingerprint, loserPauseFingerprint('acc', B));
  const row: any = loserCardToRow(card);
  assert.equal(row.title, LOSER_CARD_TITLE_AR);
  assert.equal(row.title, 'وقّف النسخة الخسرانة');
  assert.equal(row.action_payload.operation, 'pause_ad');
  assert.equal(row.action_payload.autopilot.code, 'ad_test_manual_only');
  assert.notEqual(row.action_payload.autopilot.outcome, 'execute');
  assert.ok(!/[—–,]/.test(row.description));
  // The approval handler turns it into the normal executable pause_ad (rollback is the base pause_ad one).
  const exec = buildExecutableAction(row.action_payload, row, CID);
  assert.equal(exec?.type, 'pause_ad');
  assert.equal(exec?.target_id, B);
});

test('ad test: no card without a winner, with unhealthy tracking, with an existing card, or on bad resources', async () => {
  const w = winnerTest();
  const collecting: AdTestResult = { ...w, verdict: evaluateAdTest({ ad_group_ad: A, impressions: 10, clicks: 1, conversions: 0, cost: 1 }, { ad_group_ad: B, impressions: 10, clicks: 1, conversions: 0, cost: 1 }, 2) };
  const base = { accountId: 'acc', customerId: CID, hasBlocking: async () => false };
  assert.equal((await buildLoserPauseCards({ ...base, tests: [collecting], trackingStatus: 'healthy' })).cards.length, 0);
  const broken = await buildLoserPauseCards({ ...base, tests: [w], trackingStatus: 'broken_recently' });
  assert.equal(broken.cards.length, 0);
  assert.equal(broken.skipped[0].why, 'tracking_not_healthy');
  assert.equal((await buildLoserPauseCards({ ...base, tests: [w], trackingStatus: undefined })).cards.length, 0);
  assert.equal((await buildLoserPauseCards({ ...base, tests: [w], trackingStatus: 'healthy', hasBlocking: async () => true })).cards.length, 0);
  assert.equal((await buildLoserPauseCards({ ...base, tests: null, trackingStatus: 'healthy' })).cards.length, 0);
  const foreign: AdTestResult = { ...w, verdict: { ...w.verdict, loser: 'customers/999/adGroupAds/1~2' } };
  assert.equal((await buildLoserPauseCards({ ...base, tests: [foreign], trackingStatus: 'healthy' })).cards.length, 0);
});

test('ad test: queue treats a duplicate fingerprint as "already there"', async () => {
  const out = await buildLoserPauseCards({ accountId: 'acc', customerId: CID, tests: [winnerTest()], trackingStatus: 'healthy', hasBlocking: async () => false });
  const sb = (code: string | null) => ({ from: () => ({ insert: async () => ({ error: code ? { code } : null }) }) });
  assert.equal(await queueLoserPauseCards(sb(null), 'acc', out.cards), 1);
  assert.equal(await queueLoserPauseCards(sb('23505'), 'acc', out.cards), 0);
  await assert.rejects(queueLoserPauseCards(sb('XX'), 'acc', out.cards));
});

// ---- item 5 ---------------------------------------------------------------
const H = (text: string, label: string, extra: Record<string, unknown> = {}) => ({ text, asset_performance_label: label, ...extra });
function rsaRow(disapproved: boolean) {
  const bad = disapproved
    ? { policy_summary_info: { approval_status: 'DISAPPROVED', review_status: 'REVIEWED', policy_topic_entries: [{ topic: 'UNRELIABLE_CLAIMS' }] } }
    : {};
  return {
    campaign: { resource_name: CAMPAIGN, name: 'بحث الصالون' },
    ad_group: { resource_name: GROUP, name: 'قص وتصفيف' },
    ad_group_ad: {
      resource_name: A,
      status: 'ENABLED',
      ad_strength: 'AVERAGE',
      ad: {
        id: '22',
        final_urls: ['https://rose.sa/'],
        responsive_search_ad: {
          headlines: [
            H('صالون الورد الرياض', 'BEST'),
            H('احجزي موعدك اليوم', 'GOOD'),
            H('قص وتصفيف الشعر', 'GOOD'),
            H('أفضل صالون بلا منافس', 'GOOD', bad),
            H('عناية كاملة بالبشرة', 'GOOD'),
          ],
          descriptions: [
            H('صالون نسائي في الرياض نقدم قص وصبغة وعناية بالبشرة', 'BEST'),
            H('احجزي موعدك بسهولة عبر الموقع', 'GOOD'),
            H('نخدمك في حي الورود بأجواء هادئة', 'GOOD'),
          ],
        },
      },
    },
    metrics: { impressions: 300, clicks: 10, conversions: 1, cost_micros: 1000000 },
  };
}

test('disapproved: findings read topics, labels are Arabic, unknown topics get a generic label', () => {
  const rsas = normalizeRsaRows([rsaRow(true)]);
  const found = disapprovalFindings(rsas);
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].topics, ['UNRELIABLE_CLAIMS']);
  assert.deepEqual(found[0].texts.map((t) => t.text), ['أفضل صالون بلا منافس']);
  assert.equal(policyTopicLabelAr('UNRELIABLE_CLAIMS'), 'ادعاءات غير موثوقة');
  assert.equal(policyTopicLabelAr('SOMETHING_NEW'), 'مخالفة لسياسة الإعلانات');
  assert.equal(disapprovalFindings(normalizeRsaRows([rsaRow(false)])).length, 0);
});

test('disapproved: appeal text is rules only, has no dash and no Latin comma', () => {
  const text = buildAppealText({ adName: 'قص وتصفيف', topicsAr: ['ادعاءات غير موثوقة', 'تكرار زايد'], replaced: [{ old_text: 'x', new_text: 'احجزي موعدك اليوم' }] });
  assert.ok(text.includes('قص وتصفيف'));
  assert.ok(text.includes('احجزي موعدك اليوم'));
  assert.ok(!/[—–,]/.test(text));
});

test('disapproved: the card carries a rewrite plus an appeal text, never auto-submitted', async () => {
  const rsas = normalizeRsaRows([rsaRow(true)]);
  let prompt = '';
  const writer = {
    complete: async (_s: string, user: string) => {
      prompt = user;
      return JSON.stringify({ headlines: ['حجز موعد في صالون الورد', 'قص وتصفيف الشعر عندنا'], descriptions: [] });
    },
  };
  const report = await buildAssetProposals(
    {
      accountId: 'acc',
      customerId: CID,
      report: { rsas, readable: true },
      coverage: [],
      reader: { query: async () => [] } as any,
      business: { name: 'صالون الورد', facts: ['صالون نسائي في الرياض'] },
      topTerms: [],
    },
    { writer, hasBlocking: async () => false }
  );
  assert.ok(/UNRELIABLE_CLAIMS/.test(prompt), 'the policy topic id reaches the writer');
  assert.ok(!prompt.includes('أفضل صالون بلا منافس'), 'the disapproved wording is not quoted back');
  if (report.cards.length === 1) {
    const card = report.cards[0];
    assert.equal(card.kind, 'replace_disapproved');
    assert.equal(card.action.type, 'replace_rsa_assets');
    assert.ok(card.appeal_ar && card.appeal_ar.length > 20);
    const row: any = cardToRow(card);
    assert.equal(row.action_payload.appeal_text_ar, card.appeal_ar);
    assert.notEqual(row.action_payload.autopilot.outcome, 'execute');
    assert.ok(!/[—–,]/.test(row.description));
  } else {
    assert.ok(report.skipped.length > 0, 'a refused rewrite is reported, not hidden');
  }
});

test('a normal LOW card has no appeal text (byte-identical row shape)', () => {
  const row: any = cardToRow({
    kind: 'replace_low',
    fingerprint: 'f',
    action: { type: 'replace_rsa_assets', target_id: A, params: {}, reason_ar: 'x', reason_en: 'x', expected_impact: { metric: 'ad_strength', delta_pct: 0, delta_sar_per_month: 0 } },
  });
  assert.ok(!('appeal_text_ar' in row.action_payload));
});
