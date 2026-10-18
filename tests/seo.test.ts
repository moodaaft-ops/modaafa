import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import robots from '../app/robots';
import sitemap from '../app/sitemap';
import { JsonLd, siteGraph } from '../lib/seo/json-ld';
import { AGENCY_URL, BRAND, ENTITY_IDS, OG_IMAGE, PAGE_DATES, SITE_URL, pageMetadata } from '../lib/seo/site';

// The components are written for Next's automatic JSX runtime; tsx compiles them with the classic one.
(globalThis as unknown as { React: unknown }).React = React;

function robotsRules() {
  const { rules } = robots();
  return Array.isArray(rules) ? rules : [rules];
}

const EXPECTED_PATHS = ['/', '/about', '/google-ads-audit', '/faq', '/register', '/privacy', '/terms', '/refund', '/data-deletion'];

test('sitemap lists exactly the nine public pages with absolute URLs', () => {
  const entries = sitemap();
  const urls = entries.map((entry) => entry.url);

  assert.equal(entries.length, EXPECTED_PATHS.length);
  const expected = EXPECTED_PATHS.map((path) => (path === '/' ? `${SITE_URL}/` : `${SITE_URL}${path}`));
  assert.deepEqual([...urls].sort(), [...expected].sort());
  for (const url of urls) {
    assert.match(url, /^https?:\/\//, `${url} must be absolute`);
  }
  assert.ok(!urls.some((url) => url.endsWith('/login')), '/login is not pushed in the sitemap');
});

test('sitemap lastModified comes from PAGE_DATES, never from "now"', () => {
  const entries = sitemap();
  for (const path of EXPECTED_PATHS) {
    const url = path === '/' ? `${SITE_URL}/` : `${SITE_URL}${path}`;
    const entry = entries.find((candidate) => candidate.url === url);
    assert.ok(entry, `${path} missing`);
    assert.ok(entry.lastModified instanceof Date, `${path} lastModified must be a Date`);
    assert.equal((entry.lastModified as Date).toISOString().slice(0, 10), PAGE_DATES[path], `${path} date`);
    assert.match(PAGE_DATES[path], /^\d{4}-\d{2}-\d{2}$/);
    assert.equal('changeFrequency' in entry, false);
    assert.equal('priority' in entry, false);
  }
});

test('robots has one "*" group that hides every login-only and internal path', () => {
  const result = robots();
  const rules = robotsRules();

  assert.equal(rules.length, 1, 'a per-bot group would make that bot ignore the "*" disallows');
  const rule = rules[0];
  assert.equal(rule.userAgent, '*');
  const disallow = Array.isArray(rule.disallow) ? rule.disallow : [rule.disallow ?? ''];
  for (const path of ['/home', '/start', '/welcome', '/api/', '/auth/', '/register/complete']) {
    assert.ok(disallow.includes(path), `${path} must be disallowed`);
  }
  assert.equal(result.sitemap, `${SITE_URL}/sitemap.xml`);
});

test('robots disallows every path middleware.ts treats as protected', () => {
  const middleware = readFileSync(resolve(__dirname, '../middleware.ts'), 'utf8');
  const match = middleware.match(/const protectedPaths = \[([^\]]+)\]/);
  assert.ok(match, 'protectedPaths array not found in middleware.ts');
  const protectedPaths = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(protectedPaths.length >= 10);

  const rule = robotsRules()[0];
  const disallow = Array.isArray(rule.disallow) ? rule.disallow : [rule.disallow ?? ''];
  for (const path of protectedPaths) {
    assert.ok(disallow.includes(path), `${path} is protected in middleware.ts but not disallowed in robots.ts`);
  }
});

test('siteGraph round-trips through JSON and every node has an id from ENTITY_IDS', () => {
  const graph = siteGraph();
  const roundTripped = JSON.parse(JSON.stringify(graph));
  assert.deepEqual(roundTripped, graph);
  assert.equal(roundTripped['@context'], 'https://schema.org');

  const nodes = roundTripped['@graph'] as Array<Record<string, unknown>>;
  assert.equal(nodes.length, 4);
  const allowedIds = new Set<string>(Object.values(ENTITY_IDS));
  const seen = new Set<string>();
  for (const node of nodes) {
    assert.ok(typeof node['@id'] === 'string' && allowedIds.has(node['@id']), `unexpected @id ${String(node['@id'])}`);
    seen.add(node['@id'] as string);
  }
  assert.equal(seen.size, 4, 'each entity appears once');

  const types = nodes.map((node) => node['@type']).sort();
  assert.deepEqual(types, ['Organization', 'Person', 'SoftwareApplication', 'WebSite']);

  const app = nodes.find((node) => node['@id'] === ENTITY_IDS.app);
  assert.ok(app);
  assert.equal('offers' in app, false, 'prices are added by the pages that show them');

  const org = nodes.find((node) => node['@id'] === ENTITY_IDS.org);
  assert.ok(org);
  assert.equal(org.url, AGENCY_URL, 'the agency site is the Organization url');
  assert.deepEqual(org.sameAs, [...BRAND.agencySameAs], 'the agency sameAs holds only its own social profiles');
  const orgSameAs = org.sameAs as string[];
  assert.ok(!orgSameAs.some((u) => u.includes('modaafa.com')), 'the agency url is not repeated inside sameAs');
  assert.ok(orgSameAs.every((u) => u.startsWith('https://')), 'sameAs entries are absolute https urls');
  assert.equal(new Set(orgSameAs).size, orgSameAs.length, 'no duplicate sameAs entries');
  assert.ok(
    orgSameAs.some((u) => u.startsWith('https://www.youtube.com/channel/UC')),
    'the agency YouTube channel is listed by its channel id',
  );
  assert.ok(
    !orgSameAs.some((u) => u.includes('instagram.com/moodaafa.sa')),
    'the dead agency Instagram handle stays out',
  );

  const founder = nodes.find((node) => node['@id'] === ENTITY_IDS.founder);
  assert.ok(founder);
  assert.deepEqual(founder.sameAs, [...BRAND.founderSameAs]);
});

test('JsonLd never emits a raw "<" inside the JSON and keeps Arabic unescaped', () => {
  const html = renderToStaticMarkup(
    React.createElement(JsonLd, { data: { name: '</script><b>مُضاعِف</b>', note: 'a < b' }, nonce: 'abc' }),
  );

  assert.match(html, /^<script type="application\/ld\+json"/);
  const body = html.slice(html.indexOf('>') + 1, html.lastIndexOf('</script>'));
  assert.ok(!body.includes('<'), 'the JSON body must not contain a raw "<"');
  assert.ok(body.includes('مُضاعِف'), 'Arabic stays readable');
  assert.deepEqual(JSON.parse(body), { name: '</script><b>مُضاعِف</b>', note: 'a < b' });
});

test('pageMetadata sets canonical, a complete openGraph and twitter, and noindex only on request', () => {
  const meta = pageMetadata({ title: 'صفحة', description: 'وصف الصفحة', path: '/x' });

  assert.equal(meta.title, 'صفحة');
  assert.equal(meta.description, 'وصف الصفحة');
  assert.equal(meta.alternates?.canonical, '/x');
  assert.deepEqual(meta.openGraph, {
    title: 'صفحة',
    description: 'وصف الصفحة',
    url: '/x',
    siteName: 'مُضاعِف',
    locale: 'ar_SA',
    type: 'website',
    images: [OG_IMAGE],
  });
  assert.deepEqual(meta.twitter, {
    card: 'summary_large_image',
    title: 'صفحة',
    description: 'وصف الصفحة',
    images: [OG_IMAGE.url],
  });
  assert.equal('robots' in meta, false);
});

test('pageMetadata uses the og overrides and marks noIndex pages', () => {
  const meta = pageMetadata({
    title: 'عنوان',
    description: 'وصف',
    path: '/y',
    ogTitle: 'عنوان المشاركة',
    ogDescription: 'وصف المشاركة',
    noIndex: true,
  });

  assert.equal(meta.openGraph?.title, 'عنوان المشاركة');
  assert.equal(meta.openGraph?.description, 'وصف المشاركة');
  assert.equal((meta.twitter as { title?: string }).title, 'عنوان المشاركة');
  assert.equal(meta.title, 'عنوان');
  assert.deepEqual(meta.robots, { index: false, follow: true });
});
