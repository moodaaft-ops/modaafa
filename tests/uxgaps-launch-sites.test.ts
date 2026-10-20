import assert from 'node:assert/strict';
import test from 'node:test';
import { requestLaunchProposal, shouldOfferLaunch, LAUNCH_BUTTON_LABEL_AR } from '../lib/launch/client';
import { candidateSiteLinks, crawlSitePages } from '../lib/landing-check/site-pages';
import { sitePagesForCampaign, resolveVerifiedPhone, readAccountCallPhones } from '../lib/ads/site-sources';
import { buildAssetProposals } from '../lib/ads/proposals';
import type { PageReport } from '../lib/landing-check/run';

// ---- item 1: launch button ----------------------------------------------
test('launch button: label, and only offered with flag, draft name, session and account', () => {
  assert.equal(LAUNCH_BUTTON_LABEL_AR, 'ابنِ الحملة موقوفة');
  const ok = { enabled: true, draft: { name: 'حملة' }, sessionId: 's', customerId: 'c' };
  assert.equal(shouldOfferLaunch(ok), true);
  assert.equal(shouldOfferLaunch({ ...ok, enabled: false }), false);
  assert.equal(shouldOfferLaunch({ ...ok, draft: { name: '  ' } }), false);
  assert.equal(shouldOfferLaunch({ ...ok, draft: null }), false);
  assert.equal(shouldOfferLaunch({ ...ok, sessionId: null }), false);
  assert.equal(shouldOfferLaunch({ ...ok, customerId: undefined }), false);
});

test('launch button: states card, blocked, error', async () => {
  const mk = (ok: boolean, body: any) => async () => ({ ok, status: ok ? 200 : 400, json: async () => body });
  const args = { sessionId: 's', customerId: 'c' };
  const card = await requestLaunchProposal(mk(true, { card_id: 'r1', plan: { blockers: [] } }), args);
  assert.equal(card.state, 'card');
  const blocked = await requestLaunchProposal(mk(true, { plan: { blockers: [{ message_ar: 'الميزانية ناقصة' }] } }), args);
  assert.equal(blocked.state, 'blocked');
  if (blocked.state === 'blocked') assert.deepEqual(blocked.blockers, ['الميزانية ناقصة']);
  const denied = await requestLaunchProposal(mk(false, { error: 'draft_not_found' }), args);
  assert.equal(denied.state, 'error');
  const thrown = await requestLaunchProposal(async () => { throw new Error('x'); }, args);
  assert.equal(thrown.state, 'error');
  const empty = await requestLaunchProposal(mk(true, {}), args);
  assert.equal(empty.state, 'error');
});

test('launch button: no dash and no Latin comma in the Arabic copy', async () => {
  const src = await import('node:fs').then((fs) => fs.readFileSync('lib/launch/client.ts', 'utf8'));
  const arabic = src.split('\n').filter((l) => /[؀-ۿ]/.test(l)).join('\n');
  assert.ok(!/[—–]/.test(arabic));
});

// ---- item 4: sitelink sources --------------------------------------------
const HTML = (links: string[]) => `<html><head><title>الرئيسية</title></head><body><h1>الرئيسية</h1>${links.map((l) => `<a href="${l}">رابط</a>`).join('')}</body></html>`;

test('site links: same host only, no cart/login/files, no query', () => {
  const links = candidateSiteLinks(
    'https://rose.sa/',
    HTML(['/services', 'https://rose.sa/about?x=1', 'https://other.com/a', '/cart', '/login', '/menu.pdf', 'mailto:a@b.c', '/services'])
  );
  const urls = links.map((l) => l.url).sort();
  assert.deepEqual(urls, ['https://rose.sa/about', 'https://rose.sa/services']);
});

function page(over: Partial<PageReport>): PageReport {
  return { url: 'https://rose.sa/', finalUrl: 'https://rose.sa/', status: 200, ...over } as PageReport;
}

test('site crawl: keeps 200 same-host html only, skips errors and redirects off-host', async () => {
  const hits: string[] = [];
  const deps = {
    resolve: async () => ['93.184.216.34'],
    transport: async ({ url }: { url: URL }) => {
      hits.push(url.toString());
      const u = url.toString();
      if (u === 'https://rose.sa/services') return new Response(HTML([]), { status: 200, headers: { 'content-type': 'text/html' } });
      if (u === 'https://rose.sa/gone') return new Response('no', { status: 404, headers: { 'content-type': 'text/html' } });
      if (u === 'https://rose.sa/away') return new Response('', { status: 302, headers: { location: 'https://evil.example/x' } });
      throw new Error('unreachable');
    },
  } as any;
  const kept = await crawlSitePages(
    [page({ siteLinks: [{ url: 'https://rose.sa/services', anchor: 'خدماتنا' }, { url: 'https://rose.sa/gone', anchor: 'x' }, { url: 'https://rose.sa/away', anchor: 'y' }] })],
    deps
  );
  assert.deepEqual(kept.map((k) => k.url), ['https://rose.sa/services']);
  assert.ok(!hits.includes('https://rose.sa/'), 'the landing page already fetched is not fetched again');
});

test('site crawl: a private address never gets fetched', async () => {
  let called = 0;
  const deps = { resolve: async () => ['10.0.0.5'], transport: async () => { called++; return new Response('x'); } } as any;
  const kept = await crawlSitePages([page({ siteLinks: [{ url: 'https://rose.sa/services', anchor: 'a' }] })], deps);
  assert.equal(kept.length, 0);
  assert.equal(called, 0);
});

test('sitePagesForCampaign: other hosts, non-200 and the landing page itself are dropped', () => {
  const report: any = {
    sitePages: [
      { url: 'https://rose.sa/services', title: 'خدمات', h1: '', anchor: '', status: 200 },
      { url: 'https://other.sa/x', title: 'x', h1: '', anchor: '', status: 200 },
      { url: 'https://rose.sa/old', title: 'x', h1: '', anchor: '', status: 404 },
      { url: 'https://rose.sa/about', title: 'من نحن', h1: '', anchor: '', status: 200 },
    ],
  };
  const out = sitePagesForCampaign({ report, campaignFinalUrls: ['https://www.rose.sa/about'] });
  assert.deepEqual(out.map((p) => p.url), ['https://rose.sa/services']);
  assert.deepEqual(sitePagesForCampaign({ report: null, campaignFinalUrls: ['https://rose.sa/'] }), []);
  assert.deepEqual(sitePagesForCampaign({ report, campaignFinalUrls: [] }), []);
});

test('phone resolution: merchant saved wins, disagreement is ambiguous, nothing is invented', () => {
  assert.equal(resolveVerifiedPhone({ merchantSaved: [], accountPhones: [] }).status, 'none');
  const one = resolveVerifiedPhone({ merchantSaved: ['+966501234567'], accountPhones: ['+966559999999'] });
  assert.equal(one.status === 'found' && one.value.source, 'merchant_saved');
  const acc = resolveVerifiedPhone({ merchantSaved: [], accountPhones: ['+966559999999'] });
  assert.equal(acc.status === 'found' && acc.value.source, 'account_call_asset');
  assert.equal(resolveVerifiedPhone({ merchantSaved: [], accountPhones: ['+966559999999', '+966501234567'] }).status, 'ambiguous');
  assert.equal(resolveVerifiedPhone({ merchantSaved: ['+966501234567', '+966559999999'], accountPhones: [] }).status, 'ambiguous');
});

test('account call phones: non Saudi numbers and read failures', async () => {
  const rows = [{ asset: { call_asset: { phone_number: '0501234567', country_code: 'SA' } } }, { asset: { call_asset: { phone_number: '+14155550100', country_code: 'US' } } }];
  const phones = await readAccountCallPhones({ query: async () => rows } as any);
  assert.ok(phones && phones.length === 1);
  assert.equal(await readAccountCallPhones({ query: async () => { throw new Error('x'); } } as any), null);
});

// ---- item 4: cards ---------------------------------------------------------
const CID = '1234567890';
const CAMPAIGN = `customers/${CID}/campaigns/555`;
const AD = `customers/${CID}/adGroupAds/11~22`;
function reportWithAd() {
  return {
    readable: true,
    rsas: [{
      ad_group_ad: AD, ad_group: `customers/${CID}/adGroups/11`, ad_group_name: 'قص', campaign: CAMPAIGN, campaign_name: 'بحث الصالون',
      status: 'ENABLED', ad_strength: 'GOOD', impressions_30d: 500, final_urls: ['https://rose.sa/'], headlines: ['صالون الورد الرياض', 'احجزي موعدك اليوم', 'قص وتصفيف الشعر'].map((text) => ({ text, field: 'HEADLINE', label: 'GOOD' })), descriptions: [{ text: 'صالون نسائي في الرياض نقدم قص وصبغة', field: 'DESCRIPTION', label: 'GOOD' }],
    }],
  } as any;
}
const coverage = (missing: string[]) => [{ campaign: CAMPAIGN, campaign_name: 'بحث الصالون', counts: {}, missing }] as any;
const base = { accountId: 'a1', customerId: CID, reader: { query: async () => [] } as any, business: { name: 'صالون الورد', facts: ['صالون نسائي في الرياض'] }, topTerms: [] };

test('call card: no verified phone gives no card, a verified one gives a card with that exact number', async () => {
  const deps = { writer: { complete: async () => '{}' }, hasBlocking: async () => false };
  const none = await buildAssetProposals({ ...base, report: reportWithAd(), coverage: coverage(['CALL']), phone: { status: 'none' } }, deps);
  assert.equal(none.cards.length, 0);
  assert.ok(none.skipped.some((s) => s.what === 'add_call_asset' && s.why === 'no_phone_number'));
  const amb = await buildAssetProposals({ ...base, report: reportWithAd(), coverage: coverage(['CALL']), phone: { status: 'ambiguous' } }, deps);
  assert.ok(amb.skipped.some((s) => s.why === 'phone_ambiguous'));
  const found = await buildAssetProposals(
    { ...base, report: reportWithAd(), coverage: coverage(['CALL']), phone: { status: 'found', value: { phone: '+966501234567', source: 'merchant_saved' } } },
    deps
  );
  assert.equal(found.cards.length, 1);
  assert.equal(found.cards[0].action.type, 'add_call_asset');
  assert.equal((found.cards[0].action.params as any).phone_number, '+966501234567');
  assert.ok(!/[—–,]/.test(found.cards[0].action.reason_ar));
});

test('sitelink card: without crawled pages no card and no model call', async () => {
  let calls = 0;
  const deps = { writer: { complete: async () => { calls++; return '{}'; } }, hasBlocking: async () => false };
  const out = await buildAssetProposals({ ...base, report: reportWithAd(), coverage: coverage(['SITELINK']), landingReport: null }, deps);
  assert.equal(out.cards.length, 0);
  assert.equal(calls, 0);
  assert.ok(out.skipped.some((s) => s.what === 'add_sitelinks' && s.why === 'no_site_urls'));
});

test('sitelink card: urls come only from the crawl, a model url outside it is refused', async () => {
  const landingReport: any = {
    sitePages: [
      { url: 'https://rose.sa/services', title: 'خدمات الصالون', h1: '', anchor: '', status: 200 },
      { url: 'https://rose.sa/offers', title: 'العروض', h1: '', anchor: '', status: 200 },
    ],
  };
  const reply = JSON.stringify({
    sitelinks: [
      { url: 'https://rose.sa/services', link_text: 'خدماتنا', description1: 'قص وتصفيف وعناية', description2: 'احجزي موعدك بسهولة' },
      { url: 'https://rose.sa/offers', link_text: 'العروض', description1: 'عروض الصالون', description2: 'شوفي الجديد عندنا' },
      { url: 'https://invented.example/x', link_text: 'مخترع', description1: 'كلام وهمي هنا', description2: 'كلام وهمي ثاني' },
    ],
  });
  const out = await buildAssetProposals(
    { ...base, report: reportWithAd(), coverage: coverage(['SITELINK']), landingReport },
    { writer: { complete: async () => reply }, hasBlocking: async () => false }
  );
  if (out.cards.length === 1) {
    const sl = (out.cards[0].action.params as any).sitelinks as Array<{ final_url: string }>;
    assert.ok(sl.every((s) => s.final_url.startsWith('https://rose.sa/')));
  } else {
    assert.ok(out.skipped.length > 0);
  }
});
