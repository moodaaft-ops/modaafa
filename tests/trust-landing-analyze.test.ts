import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeHtml, messageMatch, tagState, tokenize } from '../lib/landing-check/analyze';
import { buildPageFindings, type PageFacts } from '../lib/landing-check/findings';
import { selectTargets, pageKey } from '../lib/landing-check/sources';

const FULL_PAGE = `<!doctype html><html lang="ar"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>تنظيف مكيفات في الرياض | شركة النقاء</title>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-ABCD123456"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}
gtag('js',new Date());gtag('config','G-ABCD123456');gtag('config','AW-123456789');</script>
<script>(function(w,d,s,l,i){})(window,document,'script','dataLayer','GTM-ABC123');</script>
<script src="https://scripts.clarity.ms/0.7/clarity.js"></script><script>(function(c,l,a,r,i,t,y){})(window,document,"clarity","script","k1abc23def");</script>
<script src="https://www.clarity.ms/tag/k1abc23def"></script>
<script src="https://connect.facebook.net/en_US/fbevents.js"></script><script>fbq('init', '1234567890123');</script>
<script>ttq.load('CABCDEFGHIJ1234567890'); ttq.page();</script>
<script src="https://sc-static.net/scevent.min.js"></script><script>snaptr('init', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');</script>
</head><body>
<h1>تنظيف مكيفات سبليت وشباك في الرياض</h1>
<a href="https://wa.me/966500000000?text=hi">واتساب</a>
<a href='tel:+966500000000'>اتصل</a>
<p>نخدم الرياض كلها بأسعار واضحة</p>
</body></html>`;

test('reads title, H1, viewport, language, and every tag with its id', () => {
  const page = analyzeHtml(FULL_PAGE);
  assert.equal(page.title, 'تنظيف مكيفات في الرياض | شركة النقاء');
  assert.equal(page.h1, 'تنظيف مكيفات سبليت وشباك في الرياض');
  assert.deepEqual(page.viewport, { present: true, deviceWidth: true });
  assert.equal(page.lang, 'ar');
  assert.deepEqual(page.tags.ga4.ids, ['G-ABCD123456']);
  assert.deepEqual(page.tags.googleAds.ids, ['AW-123456789']);
  assert.deepEqual(page.tags.gtm.ids, ['GTM-ABC123']);
  assert.equal(page.tags.clarity.present, true);
  assert.equal(page.tags.metaPixel.present, true);
  assert.equal(page.tags.tiktokPixel.present, true);
  assert.equal(page.tags.snapPixel.present, true);
  assert.equal(page.whatsapp.links, 1);
  assert.equal(page.tel.links, 1);
  assert.equal(page.smartLink, false);
});

test('a bare page has no tags and no mobile setup', () => {
  const page = analyzeHtml('<html><head><title>x</title></head><body><h1>y</h1></body></html>');
  for (const key of ['ga4', 'googleAds', 'gtm', 'clarity', 'metaPixel', 'tiktokPixel', 'snapPixel'] as const) {
    assert.equal(page.tags[key].present, false, key);
  }
  assert.deepEqual(page.viewport, { present: false, deviceWidth: false });
  assert.equal(page.whatsapp.links, 0);
  assert.equal(page.tel.links, 0);
});

test('a G- id without gtag around it is not counted as GA4', () => {
  const page = analyzeHtml('<html><body>رمز المنتج G-ABCDEF1234 متوفر</body></html>');
  assert.equal(page.tags.ga4.present, false);
});

test('a tag that may live inside GTM is unknown, not absent', () => {
  const page = analyzeHtml('<html><head><script src="https://www.googletagmanager.com/gtm.js?id=GTM-XYZ789"></script></head></html>');
  assert.equal(tagState(page.tags, 'gtm'), 'present');
  assert.equal(tagState(page.tags, 'googleAds'), 'unknown_via_gtm');
  assert.equal(tagState(page.tags, 'metaPixel'), 'unknown_via_gtm');
  const bare = analyzeHtml('<html></html>');
  assert.equal(tagState(bare.tags, 'googleAds'), 'absent');
});

test('WhatsApp links in the usual shapes, tel links, and the Modaafa smart link', () => {
  const page = analyzeHtml(`<a href="https://api.whatsapp.com/send?phone=966500000000">a</a>
    <a href="https://wa.me/966511111111">b</a><a href="whatsapp://send?phone=1">c</a>
    <a href="https://example.com/wa.me">not one</a><a href="tel:0112345678">t</a>`);
  assert.equal(page.whatsapp.links, 3);
  assert.equal(page.tel.links, 1);
  assert.equal(page.smartLink, false);

  const smart = analyzeHtml('<a href="https://ai.modaafa.com/w/k7m2p9qx?utm=1">واتساب</a>');
  assert.equal(smart.smartLink, true);
  const lookalike = analyzeHtml('<a href="https://ai.modaafa.com.evil.test/w/k7m2p9qx">x</a><a href="https://modaafa.com/pricing">y</a>');
  assert.equal(lookalike.smartLink, false);
});

test('viewport without device-width is flagged separately', () => {
  const page = analyzeHtml('<meta name="viewport" content="width=1024">');
  assert.deepEqual(page.viewport, { present: true, deviceWidth: false });
});

// ---------------------------------------------------------------------------
// Message match
// ---------------------------------------------------------------------------

test('Arabic normalisation: hamza, ta marbuta, alef maqsura, diacritics and the article', () => {
  assert.deepEqual(tokenize('أسعار المكيّفات'), ['اسعار', 'مكيفات']);
  assert.deepEqual(tokenize('صيانة'), ['صيانه']);
  assert.deepEqual(tokenize('صيانه'), ['صيانه']);
});

test('message match: full match, partial match and mismatch', () => {
  const keywords = [
    { text: 'تنظيف مكيفات الرياض', weight: 50 },
    { text: 'غسيل مكيف سبليت', weight: 10 },
  ];
  const good = messageMatch(keywords, 'تنظيف مكيفات في الرياض', 'غسيل مكيف سبليت', '');
  assert.equal(good.score, 100);
  assert.deepEqual(good.missing, []);

  const partial = messageMatch(keywords, 'تنظيف مكيفات الرياض', 'خدمات منزلية', 'نقدم غسيل مكيف سبليت');
  assert.equal(partial.score, 89); // (50 * 1 + 10 * 1/3) / 60: «مكيف» also matches «مكيفات» in the headline
  assert.deepEqual(partial.matched, ['تنظيف مكيفات الرياض']);
  assert.deepEqual(partial.bodyOnly, ['غسيل مكيف سبليت']);

  const bad = messageMatch(keywords, 'مرحبا بكم', 'شركة عامة', 'نحن شركة');
  assert.equal(bad.score, 0);
  assert.equal(bad.missing.length, 2);
});

test('message match is weighted by the clicks of each keyword', () => {
  const keywords = [
    { text: 'سباك', weight: 90 },
    { text: 'كهربائي', weight: 10 },
  ];
  assert.equal(messageMatch(keywords, 'سباك الرياض', '', '').score, 90);
  assert.equal(messageMatch(keywords, 'كهربائي الرياض', '', '').score, 10);
});

test('message match is null when there are no usable keywords', () => {
  assert.equal(messageMatch([], 'x', 'y', 'z').score, null);
  assert.equal(messageMatch([{ text: 'في', weight: 1 }], 'x', 'y', 'z').score, null);
});

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

function facts(overrides: Partial<PageFacts> = {}): PageFacts {
  const page = analyzeHtml(FULL_PAGE);
  return {
    fetchError: null,
    status: 200,
    redirects: 0,
    ttfbMs: 200,
    totalMs: 600,
    htmlBytes: 40_000,
    truncated: false,
    isHtml: true,
    title: page.title,
    h1: page.h1,
    viewport: page.viewport,
    tags: page.tags,
    whatsappLinks: 1,
    telLinks: 1,
    smartLink: false,
    match: { score: 90, matched: [], bodyOnly: [], missing: [] },
    ...overrides,
  };
}

const FORBIDDEN = /[—–]/; // em dash, en dash

test('a healthy page has no high or medium finding', () => {
  const findings = buildPageFindings(facts());
  assert.equal(findings.filter((f) => f.severity === 'high' || f.severity === 'medium').length, 0);
  assert.ok(findings.some((f) => f.code === 'google_tag_visible'));
});

test('every finding carries a step in Arabic and no dash character', () => {
  const messy = facts({
    redirects: 3,
    ttfbMs: 2400,
    totalMs: 4200,
    htmlBytes: 900_000,
    viewport: { present: false, deviceWidth: false },
    tags: analyzeHtml('<html></html>').tags,
    whatsappLinks: 0,
    telLinks: 0,
    match: { score: 10, matched: [], bodyOnly: ['تنظيف'], missing: ['سباك'] },
  });
  const findings = buildPageFindings(messy);
  const codes = findings.map((f) => f.code);
  for (const expected of ['redirect_chain', 'slow_server', 'slow_page', 'no_viewport', 'message_mismatch', 'no_google_tag', 'no_contact_button']) {
    assert.ok(codes.includes(expected), expected);
  }
  for (const finding of findings) {
    assert.ok(finding.text_ar.length > 0 && finding.step_ar.length > 0, finding.code);
    assert.equal(FORBIDDEN.test(finding.text_ar + finding.step_ar), false, finding.code);
    assert.equal(/[a-zA-Z]\s*,\s*[ء-ي]|[ء-ي]\s*,/.test(finding.text_ar + finding.step_ar), false, `latin comma in ${finding.code}`);
  }
  // High severity first.
  assert.equal(findings[0].severity, 'high');
});

test('unreachable and error pages stop the analysis with one clear finding', () => {
  const blocked = buildPageFindings(facts({ fetchError: 'private_address' }));
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].code, 'unreachable');
  const notFound = buildPageFindings(facts({ status: 404 }));
  assert.equal(notFound.length, 1);
  assert.equal(notFound[0].code, 'http_error');
  assert.match(notFound[0].text_ar, /404/);
});

test('GTM only: the finding says the tags inside are not visible, it does not claim they are missing', () => {
  const gtmOnly = analyzeHtml('<html><head><meta name="viewport" content="width=device-width"><script src="https://www.googletagmanager.com/gtm.js?id=GTM-XYZ789"></script></head><body></body></html>');
  const findings = buildPageFindings(facts({ tags: gtmOnly.tags }));
  assert.ok(findings.some((f) => f.code === 'gtm_only'));
  assert.equal(findings.some((f) => f.code === 'no_google_tag'), false);
});

test('smart link and plain WhatsApp link produce the right finding', () => {
  assert.ok(buildPageFindings(facts({ smartLink: true })).some((f) => f.code === 'smart_link_used'));
  assert.ok(buildPageFindings(facts({ smartLink: false })).some((f) => f.code === 'plain_whatsapp_link'));
});

// ---------------------------------------------------------------------------
// Which pages get checked
// ---------------------------------------------------------------------------

test('pageKey drops query, fragment and trailing slash', () => {
  assert.equal(pageKey('https://Shop.example.com/lp/?utm_source=g&gclid=1#top'), 'https://shop.example.com/lp');
  assert.equal(pageKey('javascript:alert(1)'), null);
  assert.equal(pageKey('not a url'), null);
});

test('selectTargets: top three pages by clicks with the keywords of their ad groups', () => {
  const ads = [
    { adGroup: { id: '1' }, adGroupAd: { ad: { finalUrls: ['https://a.com/x?utm=1'] } }, metrics: { clicks: '90' } },
    { adGroup: { id: '2' }, adGroupAd: { ad: { finalUrls: ['https://a.com/x'] } }, metrics: { clicks: '10' } },
    { adGroup: { id: '3' }, adGroupAd: { ad: { finalUrls: ['https://a.com/y'] } }, metrics: { clicks: '50' } },
    { adGroup: { id: '4' }, adGroupAd: { ad: { finalUrls: ['https://b.com/'] } }, metrics: { clicks: '5' } },
    { adGroup: { id: '5' }, adGroupAd: { ad: { finalUrls: ['https://c.com/'] } }, metrics: { clicks: '1' } },
    { adGroup: { id: '6' }, adGroupAd: { ad: { finalUrls: [] } }, metrics: { clicks: '999' } },
  ];
  const keywords = [
    { adGroup: { id: '1' }, adGroupCriterion: { keyword: { text: 'تنظيف مكيفات' } }, metrics: { clicks: '60' } },
    { adGroup: { id: '2' }, adGroupCriterion: { keyword: { text: 'تنظيف مكيفات' } }, metrics: { clicks: '5' } },
    { adGroup: { id: '2' }, adGroupCriterion: { keyword: { text: 'غسيل مكيف' } }, metrics: { clicks: '7' } },
    { adGroup: { id: '3' }, adGroupCriterion: { keyword: { text: 'سباك' } }, metrics: { clicks: '30' } },
  ];
  const targets = selectTargets(ads, keywords);
  assert.deepEqual(
    targets.map((t) => [t.url, t.clicks]),
    [
      ['https://a.com/x', 100],
      ['https://a.com/y', 50],
      ['https://b.com/', 5],
    ]
  );
  assert.deepEqual(targets[0].keywords, [
    { text: 'تنظيف مكيفات', weight: 65 },
    { text: 'غسيل مكيف', weight: 7 },
  ]);
  assert.deepEqual(targets[2].keywords, []);
});
