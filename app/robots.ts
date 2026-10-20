import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/seo/site';

// Keep this list in step with `protectedPaths` in middleware.ts: every path
// that needs a login must also be hidden from crawlers. It is duplicated (not
// imported) so middleware behavior is never touched by an SEO change;
// tests/seo.test.ts reads middleware.ts and fails if a protected path is
// missing here.
const PROTECTED_PATHS = [
  '/dashboard',
  '/home',
  '/assistant',
  '/start',
  '/audit',
  '/campaigns',
  '/optimizer',
  '/reports',
  '/billing',
  '/settings',
  '/onboarding',
  '/autopilot',
  '/operations',
  '/partners',
  '/welcome',
  '/guide',
  '/leads',
];

// One `*` group on purpose. A crawler that matches a more specific user-agent
// group ignores the `*` group entirely, so a per-bot group would silently
// drop these disallows for that bot.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: [...PROTECTED_PATHS, '/api/', '/auth/', '/register/complete'],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
