import { numOrNull, pick, strOrEmpty } from '@/lib/ai/optimizer-gates';
import type { KeywordInput } from './analyze';

/** Final URLs of the enabled ads that got the clicks, and the keywords of their ad groups. */
export const FINAL_URLS_GAQL = `
  SELECT ad_group.id, ad_group_ad.ad.final_urls, metrics.clicks
  FROM ad_group_ad
  WHERE segments.date DURING LAST_30_DAYS
    AND ad_group_ad.status = 'ENABLED'
    AND campaign.status = 'ENABLED'
  ORDER BY metrics.clicks DESC
  LIMIT 200`;

export const KEYWORDS_GAQL = `
  SELECT ad_group.id, ad_group_criterion.keyword.text, metrics.clicks
  FROM keyword_view
  WHERE segments.date DURING LAST_30_DAYS
    AND ad_group_criterion.status = 'ENABLED'
    AND ad_group_criterion.negative = FALSE
  ORDER BY metrics.clicks DESC
  LIMIT 300`;

export const MAX_TARGETS = 3;
export const MAX_KEYWORDS_PER_TARGET = 5;

export type CheckTarget = { url: string; clicks: number; keywords: KeywordInput[] };

/** Same page, no query string or fragment: utm and click ids are not a different page. */
export function pageKey(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    const path = url.pathname.replace(/\/+$/, '') || '/';
    return `${url.protocol}//${url.host.toLowerCase()}${path}`;
  } catch {
    return null;
  }
}

function finalUrlsOf(row: unknown): string[] {
  const raw = pick(row, 'ad_group_ad.ad.final_urls');
  return Array.isArray(raw) ? raw.map((value) => strOrEmpty(value)).filter(Boolean) : [];
}

/**
 * The top pages by clicks (max 3), each with the top keywords of the ad groups
 * that send traffic to it. A page that only PMax asset groups reach has no
 * keywords, and the message match is then simply not computed.
 */
export function selectTargets(adRows: unknown[], keywordRows: unknown[]): CheckTarget[] {
  const clicksByPage = new Map<string, { clicks: number; groups: Set<string> }>();
  for (const row of adRows) {
    const group = strOrEmpty(pick(row, 'ad_group.id'));
    const clicks = numOrNull(pick(row, 'metrics.clicks')) ?? 0;
    const first = finalUrlsOf(row)[0];
    const key = first ? pageKey(first) : null;
    if (!key) continue;
    const entry = clicksByPage.get(key) ?? { clicks: 0, groups: new Set<string>() };
    entry.clicks += clicks;
    if (group) entry.groups.add(group);
    clicksByPage.set(key, entry);
  }

  const keywordsByGroup = new Map<string, Map<string, number>>();
  for (const row of keywordRows) {
    const group = strOrEmpty(pick(row, 'ad_group.id'));
    const text = strOrEmpty(pick(row, 'ad_group_criterion.keyword.text')).trim();
    if (!group || !text) continue;
    const clicks = numOrNull(pick(row, 'metrics.clicks')) ?? 0;
    const map = keywordsByGroup.get(group) ?? new Map<string, number>();
    map.set(text, (map.get(text) ?? 0) + clicks);
    keywordsByGroup.set(group, map);
  }

  return Array.from(clicksByPage.entries())
    .sort((a, b) => b[1].clicks - a[1].clicks || a[0].localeCompare(b[0]))
    .slice(0, MAX_TARGETS)
    .map(([url, entry]) => {
      const merged = new Map<string, number>();
      for (const group of entry.groups) {
        for (const [text, clicks] of keywordsByGroup.get(group) ?? []) merged.set(text, (merged.get(text) ?? 0) + clicks);
      }
      const keywords = Array.from(merged.entries())
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, MAX_KEYWORDS_PER_TARGET)
        .map(([text, clicks]) => ({ text, weight: Math.max(1, clicks) }));
      return { url, clicks: entry.clicks, keywords };
    });
}
