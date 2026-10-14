import type { MetadataRoute } from 'next';
import { PAGE_DATES, SITE_URL } from '@/lib/seo/site';

// Only public, indexable pages. /login stays indexable (it is not noindexed)
// but is not a page we push. changeFrequency and priority are left out on
// purpose: Google ignores both, and lastModified comes from PAGE_DATES so it
// only moves when a page's content really changes, never on every request.
const SITEMAP_PATHS = [
  '/',
  '/about',
  '/google-ads-audit',
  '/register',
  '/privacy',
  '/terms',
  '/refund',
  '/data-deletion',
] as const;

export default function sitemap(): MetadataRoute.Sitemap {
  return SITEMAP_PATHS.map((path) => ({
    url: path === '/' ? `${SITE_URL}/` : `${SITE_URL}${path}`,
    lastModified: new Date(`${PAGE_DATES[path]}T00:00:00Z`),
  }));
}
