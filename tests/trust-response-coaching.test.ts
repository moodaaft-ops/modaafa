import assert from 'node:assert/strict';
import test from 'node:test';
import {
  coachingLinesForReport,
  detectCoaching,
  type CoachingInput,
} from '../lib/coaching/response-coaching';
import { loadCoachingInput, loadLeadStats } from '../lib/coaching/load';
import { getResponseCoachingTool } from '../lib/jarvis/tools/get-response-coaching';
import { JARVIS_READ_TOOLS } from '../lib/jarvis/tools';
import { offerCoachingEnabled } from '../lib/coaching/flag';

const base: CoachingInput = {
  windowDays: 30,
  clicks: 600,
  impressions: 9000, // CTR 6.7%
  conversions: 40,
  history: { clicks: 1500, impressions: 22000, conversions: 100 },
  leads: { total: 60, marked: 30, customers: 2, notSerious: 4, noReply: 12 },
};

const FORBIDDEN = /[—–]/;

test('good CTR, many WhatsApp clicks and few customers: points at the offer or the reply speed, with honest wording', () => {
  const insights = detectCoaching(base);
  const offer = insights.find((i) => i.code === 'offer_or_response');
  assert.ok(offer);
  assert.equal(offer.where, 'outside_account');
  assert.match(offer.text_ar, /غالباً/);
  assert.match(offer.text_ar, /استنتاج/);
  assert.match(offer.text_ar, /60 ضغطة واتساب/);
  assert.match(offer.text_ar, /من 30 علّمتهم صار زبون 2 بس/);
  assert.match(offer.text_ar, /12 منهم ما ردّوا/);
  assert.equal(FORBIDDEN.test(offer.text_ar + offer.step_ar), false);
});

test('does not fire without enough WhatsApp clicks or enough verdicts', () => {
  assert.equal(detectCoaching({ ...base, leads: { ...base.leads!, total: 19 } }).some((i) => i.code === 'offer_or_response'), false);
  assert.equal(detectCoaching({ ...base, leads: { ...base.leads!, marked: 9 } }).some((i) => i.code === 'offer_or_response'), false);
  assert.equal(detectCoaching({ ...base, leads: null }).some((i) => i.code === 'offer_or_response'), false);
});

test('does not fire when the customer rate is healthy', () => {
  const healthy = { ...base.leads!, customers: 8 }; // 8 of 30 = 26%
  assert.equal(detectCoaching({ ...base, leads: healthy }).some((i) => i.code === 'offer_or_response'), false);
});

test('does not blame the offer when the click-through is weak', () => {
  const weak = { ...base, clicks: 100, impressions: 9000 }; // CTR 1.1%
  assert.equal(detectCoaching(weak).some((i) => i.code === 'offer_or_response'), false);
});

test('a sector median CTR replaces the fixed floor', () => {
  const lowSector = { ...base, clicks: 300, impressions: 9000, sectorMedianCtr: 0.03 }; // CTR 3.3% beats a 3% sector median
  assert.equal(detectCoaching(lowSector).some((i) => i.code === 'offer_or_response'), true);
  const highSector = { ...lowSector, sectorMedianCtr: 0.08 };
  assert.equal(detectCoaching(highSector).some((i) => i.code === 'offer_or_response'), false);
});

test('when many leads are marked «مو جاد» the finding points inside the account, not at the offer', () => {
  const noisy = { ...base, leads: { total: 60, marked: 30, customers: 2, notSerious: 15, noReply: 5 } };
  const insights = detectCoaching(noisy);
  assert.equal(insights.some((i) => i.code === 'offer_or_response'), false);
  const traffic = insights.find((i) => i.code === 'traffic_quality');
  assert.ok(traffic);
  assert.equal(traffic.where, 'inside_account');
});

test('conversion rate dropped while CTR stayed: outside the account, with both rates quoted', () => {
  const drop = detectCoaching({ ...base, leads: null, conversions: 6 }); // 1% now vs 6.7% before
  const found = drop.find((i) => i.code === 'conversion_rate_drop');
  assert.ok(found);
  assert.equal(found.where, 'outside_account');
  assert.match(found.text_ar, /من 6.7% إلى 1%/);
});

test('no conversion rate finding when the CTR fell too, or the sample is small, or history is missing', () => {
  assert.equal(detectCoaching({ ...base, leads: null, conversions: 6, impressions: 60000 }).length, 0); // CTR collapsed: an ad problem
  assert.equal(detectCoaching({ ...base, leads: null, conversions: 2, clicks: 100 }).length, 0);
  assert.equal(detectCoaching({ ...base, leads: null, conversions: 6, history: null }).length, 0);
  assert.equal(detectCoaching({ ...base, leads: null, conversions: 6, history: { clicks: 100, impressions: 1000, conversions: 5 } }).length, 0);
  assert.equal(detectCoaching({ ...base, leads: null, conversions: 38 }).length, 0); // small dip is noise
});

test('report lines carry the wording and the step', () => {
  const lines = coachingLinesForReport(detectCoaching({ ...base, conversions: 6 }));
  assert.equal(lines.length, 2);
  assert.ok(lines.every((line) => line.includes('الخطوة:')));
});

// ---------------------------------------------------------------------------
// Loaders and the tool
// ---------------------------------------------------------------------------

test('lead stats count the verdicts and survive a missing table', async () => {
  const rows = [
    { status: 'new' },
    { status: 'customer' },
    { status: 'customer' },
    { status: 'no_reply' },
    { status: 'not_serious' },
  ];
  const admin = { from: () => ({ select: () => ({ eq: () => ({ gte: () => ({ limit: async () => ({ data: rows, error: null }) }) }) }) }) };
  assert.deepEqual(await loadLeadStats(admin, 'a', new Date()), { total: 5, marked: 4, customers: 2, notSerious: 1, noReply: 1 });
  const broken = { from: () => ({ select: () => ({ eq: () => ({ gte: () => ({ limit: async () => ({ data: null, error: { message: 'no table' } }) }) }) }) }) };
  assert.equal(await loadLeadStats(broken, 'a', new Date()), null);
});

test('loadCoachingInput sums both windows', async () => {
  const customer = {
    async query(gaql: string) {
      return gaql.includes('BETWEEN')
        ? [{ metrics: { clicks: '100', impressions: '1000', conversions: '5' } }]
        : [{ metrics: { clicks: '10', impressions: '100', conversions: '1' } }, { metrics: { clicks: '5', impressions: '50', conversions: '0' } }];
    },
  };
  const input = await loadCoachingInput({ customer, admin: null, accountId: 'a', now: new Date('2026-10-20T00:00:00Z') });
  assert.deepEqual([input.clicks, input.impressions, input.conversions], [15, 150, 1]);
  assert.deepEqual(input.history, { clicks: 100, impressions: 1000, conversions: 5 });
  assert.equal(input.leads, null);
});

test('flag off: the tool is not registered', () => {
  assert.equal(offerCoachingEnabled({}), false);
  assert.equal(getResponseCoachingTool.name, 'get_response_coaching');
  if (process.env.OFFER_COACHING_ENABLED !== 'true') {
    assert.equal(JARVIS_READ_TOOLS.some((tool) => tool.name === 'get_response_coaching'), false);
  }
});
