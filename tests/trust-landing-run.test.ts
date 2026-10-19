import assert from 'node:assert/strict';
import test from 'node:test';
import {
  dueForCheck,
  getLandingCheck,
  LANDING_CHECK_MIN_INTERVAL_MS,
  runLandingCheck,
  type LandingCheckReport,
  type LandingCheckStore,
  type StoredLandingCheck,
} from '../lib/landing-check/run';
import type { CheckTarget } from '../lib/landing-check/sources';
import type { FetchDeps } from '../lib/landing-check/fetch';
import { createLandingCheckTool } from '../lib/jarvis/tools/get-landing-check';
import { JARVIS_READ_TOOLS } from '../lib/jarvis/tools';
import { landingCheckEnabled } from '../lib/landing-check/flag';

const PAGE = `<html lang="ar"><head><meta name="viewport" content="width=device-width">
<title>تنظيف مكيفات الرياض</title>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-ABCD123456"></script>
<script>gtag('config','AW-123456789')</script></head>
<body><h1>تنظيف مكيفات الرياض</h1><a href="https://ai.modaafa.com/w/k7m2p9qx">واتساب</a></body></html>`;

function fetchDeps(pages: Record<string, string | number>): { deps: FetchDeps; hits: string[] } {
  const hits: string[] = [];
  return {
    hits,
    deps: {
      resolve: async () => ['93.184.216.34'],
      transport: async ({ url }) => {
        hits.push(url.toString());
        const entry = pages[url.toString()];
        if (typeof entry === 'number') return new Response('nope', { status: entry, headers: { 'content-type': 'text/html' } });
        if (entry === undefined) throw new Error('unreachable');
        return new Response(entry, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
      },
    },
  };
}

function memoryStore(initial: StoredLandingCheck | null = null) {
  let row = initial;
  const saved: LandingCheckReport[] = [];
  const store: LandingCheckStore = {
    async latest() {
      return row;
    },
    async save(_accountId, report) {
      saved.push(report);
      row = { checked_at: report.checkedAt, report };
    },
  };
  return { store, saved };
}

const targets: CheckTarget[] = [{ url: 'https://shop.example.com/ac', clicks: 120, keywords: [{ text: 'تنظيف مكيفات', weight: 100 }] }];

test('a full run reports status, timings, tags, smart link and a good message match', async () => {
  const { deps } = fetchDeps({ 'https://shop.example.com/ac': PAGE });
  const report = await runLandingCheck(targets, deps, new Date('2026-10-20T08:00:00Z'));
  assert.equal(report.pages.length, 1);
  const page = report.pages[0];
  assert.equal(page.status, 200);
  assert.equal(page.viewport?.deviceWidth, true);
  assert.equal(page.tags?.googleAds, 'present');
  assert.equal(page.tags?.ga4, 'present');
  assert.equal(page.smartLink, true);
  assert.equal(page.match?.score, 100);
  assert.equal(report.tracking.googleTag, 'visible');
});

test('tracking evidence: not visible when the page has no Google tag and no GTM', async () => {
  const { deps } = fetchDeps({ 'https://shop.example.com/ac': '<html><head><title>x</title></head><body>hi</body></html>' });
  const report = await runLandingCheck(targets, deps, new Date());
  assert.equal(report.tracking.googleTag, 'not_visible');
  assert.ok(report.findings.some((f) => f.code === 'no_google_tag' && f.severity === 'high'));
});

test('tracking evidence: unknown when no page could be read', async () => {
  const { deps } = fetchDeps({ 'https://shop.example.com/ac': 500 });
  const report = await runLandingCheck(targets, deps, new Date());
  assert.equal(report.pages[0].status, 500);
  assert.ok(report.findings.some((f) => f.code === 'http_error'));
  assert.equal(report.tracking.googleTag, 'unknown');
});

test('an SSRF-style target inside a run is reported as unreachable, never fetched', async () => {
  const { deps, hits } = fetchDeps({});
  const report = await runLandingCheck([{ url: 'https://169.254.169.254/latest', clicks: 5, keywords: [] }], deps, new Date());
  assert.equal(report.pages[0].fetchError, 'ip_literal');
  assert.equal(hits.length, 0);
});

test('weekly cadence: due only after seven days', () => {
  const now = new Date('2026-10-20T08:00:00Z');
  assert.equal(dueForCheck(null, now), true);
  assert.equal(dueForCheck('garbage', now), true);
  assert.equal(dueForCheck(new Date(now.getTime() - LANDING_CHECK_MIN_INTERVAL_MS + 60_000).toISOString(), now), false);
  assert.equal(dueForCheck(new Date(now.getTime() - LANDING_CHECK_MIN_INTERVAL_MS).toISOString(), now), true);
});

test('getLandingCheck reuses a report younger than a week and does not fetch', async () => {
  const now = new Date('2026-10-20T08:00:00Z');
  const first = fetchDeps({ 'https://shop.example.com/ac': PAGE });
  const report = await runLandingCheck(targets, first.deps, new Date(now.getTime() - 2 * 86_400_000));
  const { store, saved } = memoryStore({ checked_at: report.checkedAt, report });
  const second = fetchDeps({ 'https://shop.example.com/ac': PAGE });
  let loaded = 0;
  const result = await getLandingCheck({
    store,
    accountId: 'a1',
    deps: second.deps,
    now,
    loadTargets: async () => {
      loaded += 1;
      return targets;
    },
  });
  assert.equal(result.status, 'cached');
  if (result.status === 'cached') assert.equal(result.ageDays, 2);
  assert.equal(second.hits.length, 0);
  assert.equal(loaded, 0);
  assert.equal(saved.length, 0);
});

test('getLandingCheck runs and stores a new report when the last one is eight days old', async () => {
  const now = new Date('2026-10-20T08:00:00Z');
  const old = await runLandingCheck(targets, fetchDeps({ 'https://shop.example.com/ac': PAGE }).deps, new Date(now.getTime() - 8 * 86_400_000));
  const { store, saved } = memoryStore({ checked_at: old.checkedAt, report: old });
  const fresh = fetchDeps({ 'https://shop.example.com/ac': PAGE });
  const result = await getLandingCheck({ store, accountId: 'a1', deps: fresh.deps, now, loadTargets: async () => targets });
  assert.equal(result.status, 'fresh');
  assert.equal(fresh.hits.length, 1);
  assert.equal(saved.length, 1);
});

test('getLandingCheck with no pages and no history says so', async () => {
  const { store } = memoryStore(null);
  const result = await getLandingCheck({ store, accountId: 'a1', deps: fetchDeps({}).deps, now: new Date(), loadTargets: async () => [] });
  assert.equal(result.status, 'no_pages');
});

test('a store that cannot save does not lose the report', async () => {
  const store: LandingCheckStore = {
    async latest() {
      return null;
    },
    async save() {
      throw new Error('table missing');
    },
  };
  const result = await getLandingCheck({
    store,
    accountId: 'a1',
    deps: fetchDeps({ 'https://shop.example.com/ac': PAGE }).deps,
    now: new Date(),
    loadTargets: async () => targets,
  });
  assert.equal(result.status, 'fresh');
});

// ---------------------------------------------------------------------------
// Jarvis tool
// ---------------------------------------------------------------------------

test('the Jarvis tool reads the account URLs and keywords through GAQL and returns a compact Arabic summary', async () => {
  const queries: string[] = [];
  const customer = {
    async query(gaql: string) {
      queries.push(gaql);
      if (gaql.includes('FROM ad_group_ad')) {
        return [{ adGroup: { id: '1' }, adGroupAd: { ad: { finalUrls: ['https://shop.example.com/ac?gclid=1'] } }, metrics: { clicks: '40' } }];
      }
      return [{ adGroup: { id: '1' }, adGroupCriterion: { keyword: { text: 'تنظيف مكيفات' } }, metrics: { clicks: '30' } }];
    },
  };
  const { store } = memoryStore(null);
  const tool = createLandingCheckTool({
    store: () => store,
    fetchDeps: fetchDeps({ 'https://shop.example.com/ac': PAGE }).deps,
  });
  const result = await tool.run(
    {},
    { customer, accountId: 'a1', customerId: '1234567890', currencyCode: 'SAR', business: null, now: new Date('2026-10-20T08:00:00Z') }
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    const summary = result.summary as any;
    assert.equal(summary.status, 'fresh');
    assert.equal(summary.pages[0].page, 'shop.example.com/ac');
    assert.equal(summary.pages[0].message_match.score, 100);
    assert.equal(summary.tracking_evidence.googleTag, 'visible');
    assert.equal(result.rows.length, 0);
  }
  assert.equal(queries.length, 2);
});

test('the Jarvis tool refuses unexpected input', async () => {
  const tool = createLandingCheckTool({ store: () => null, fetchDeps: fetchDeps({}).deps });
  await assert.rejects(
    tool.run({ url: 'https://169.254.169.254/' }, { customer: { query: async () => [] }, accountId: 'a', customerId: '1', currencyCode: 'SAR', business: null, now: new Date() }),
    /unknown field/
  );
});

test('flag off: the tool is not in the Jarvis tool list', () => {
  assert.equal(landingCheckEnabled({}), false);
  assert.equal(landingCheckEnabled({ LANDING_CHECK_ENABLED: 'true' }), true);
  if (process.env.LANDING_CHECK_ENABLED !== 'true') {
    assert.equal(JARVIS_READ_TOOLS.some((tool) => tool.name === 'get_landing_check'), false);
  }
});
