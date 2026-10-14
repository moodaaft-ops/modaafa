#!/usr/bin/env node
// Tells IndexNow-compatible search engines (Bing, Yandex, Seznam, Naver...)
// which URLs changed, so they re-crawl now instead of on their own schedule.
//
// Usage:
//   node scripts/seo/indexnow-ping.mjs                 # pings https://ai.modaafa.com
//   node scripts/seo/indexnow-ping.mjs https://other   # pings another origin
//
// The key below must match the file public/<key>.txt (its content is exactly
// the key), which is how the engine verifies that we own the host. Run this
// only after a deploy that changed page content; do not run it on a schedule.

const KEY = '76753e65471e9fb7ba03db72b41bbf1e';

const SITE = (process.argv[2] ?? 'https://ai.modaafa.com').replace(/\/+$/, '');
const host = new URL(SITE).host;

const sitemapUrl = `${SITE}/sitemap.xml`;
const sitemapResponse = await fetch(sitemapUrl);
if (!sitemapResponse.ok) {
  console.error(`Could not fetch ${sitemapUrl}: HTTP ${sitemapResponse.status}`);
  process.exit(1);
}

const xml = await sitemapResponse.text();
const urlList = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((match) => match[1]);
if (urlList.length === 0) {
  console.error(`No <loc> entries found in ${sitemapUrl}`);
  process.exit(1);
}

const payload = {
  host,
  key: KEY,
  keyLocation: `${SITE}/${KEY}.txt`,
  urlList,
};

const response = await fetch('https://api.indexnow.org/indexnow', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify(payload),
});

console.log(`IndexNow: ${urlList.length} URLs for ${host} -> HTTP ${response.status} ${response.statusText}`);
// 200 = accepted, 202 = accepted and key validation pending. 403 = key file not
// reachable yet (deploy first). 422 = URLs do not belong to the host.
if (response.status !== 200 && response.status !== 202) {
  console.error(await response.text());
  process.exit(1);
}
