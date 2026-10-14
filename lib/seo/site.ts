import type { Metadata } from 'next';

/**
 * Single source of truth for everything search engines and AI answer engines
 * read about the site: canonical origin, entity ids, brand facts, positioning
 * sentence, and per-page metadata. The pages, sitemap, robots and JSON-LD graph
 * all import from here so the facts cannot drift apart.
 */

export const SITE_URL: string = (process.env.NEXT_PUBLIC_APP_URL ?? 'https://ai.modaafa.com').replace(/\/+$/, '');

export const AGENCY_URL = 'https://modaafa.com/';

// These @ids are intentionally the same ones the homepage graph uses, so the
// sitewide graph and any page-level graph merge into one set of entities.
export const ENTITY_IDS = {
  website: `${SITE_URL}/#website`,
  org: `${SITE_URL}/#org`,
  app: `${SITE_URL}/#app`,
  founder: `${SITE_URL}/#ayman`,
} as const;

export const BRAND = {
  nameAr: 'مُضاعِف',
  nameEn: 'Modaafa',
  appName: 'Modaafa Ads AI',
  agencyNameAr: 'مُضاعفة',
  agencyNameEn: 'Mudaafa',
  legalName: 'مؤسسة تقنيات أيمن للتسويق الإلكتروني',
  unifiedNumber: '7038156571',
  founderAr: 'أيمن أمين',
  founderEn: 'Ayman Amin',
  founderTitle: 'مؤسس وكالة مُضاعفة ومنصة مُضاعِف',
  email: 'moodaaft@gmail.com',
  whatsappLocal: '0541004029',
  whatsappIntl: '+966541004029',
  // Only profiles opened and confirmed live on 14 Oct 2026. The agency's
  // Instagram link in the modaafa.com footer returned "profile not available",
  // so it stays out until the owner confirms the handle.
  agencySameAs: [
    'https://x.com/moodaafa_sa',
    'https://www.tiktok.com/@moodaafa.sa',
    'https://www.snapchat.com/@moodaafa.sa',
  ],
  founderSameAs: [
    'https://www.tiktok.com/@aiman.google.ads',
    'https://www.instagram.com/aiman.google.ads/',
  ],
} as const;

export const POSITIONING_AR =
  'مُضاعِف (Modaafa) منصة سعودية تقرأ حساب إعلانات جوجل كل يوم، وتجهّز لصاحبه قرارات تحسين مع سبب كل قرار من أرقام حسابه، ولا تغيّر شيئاً في الحساب إلا بعد موافقته.';

export const POSITIONING_EN =
  "Modaafa (مُضاعِف) is a Saudi platform that reads a Google Ads account every day, prepares optimization decisions with the reason for each one from the account's own numbers, and changes nothing in the account without the owner's approval.";

// Fallback list prices (SAR, before VAT). The homepage reads live prices from
// Stripe; app/page.tsx keeps its own copy of these three numbers and no shared
// constant exists in lib/billing. Keep in sync with Stripe list prices.
export const PLAN_PRICES_SAR = [
  { key: 'starter', nameAr: 'البداية', monthly: 500 },
  { key: 'growth', nameAr: 'النمو', monthly: 1200 },
  { key: 'pro', nameAr: 'الاحتراف', monthly: 2500 },
] as const;

export const OG_IMAGE = {
  url: '/og-image.png',
  width: 1200,
  height: 630,
  alt: 'مُضاعِف - Modaafa Ads AI',
} as const;

// Honest last-modified dates (YYYY-MM-DD) for the sitemap. Update a date ONLY
// when that page's content really changes: crawlers learn to ignore a
// lastmod that moves on every deploy. The legal dates mirror the visible
// `updatedAt` prop of each legal page.
export const PAGE_DATES: Record<string, string> = {
  '/': '2026-10-14',
  '/about': '2026-10-14',
  '/google-ads-audit': '2026-10-14',
  '/register': '2026-10-14',
  '/privacy': '2026-09-29',
  '/terms': '2026-10-07',
  '/refund': '2026-10-07',
  '/data-deletion': '2026-07-21',
};

/**
 * Metadata for one page. Next replaces (does not merge) a parent's `openGraph`
 * and `twitter` objects, so every page that sets its own title must carry a
 * COMPLETE set; otherwise it loses the image and the site name.
 */
export function pageMetadata(input: {
  title: string;
  description: string;
  path: string;
  ogTitle?: string;
  ogDescription?: string;
  noIndex?: boolean;
}): Metadata {
  const ogTitle = input.ogTitle ?? input.title;
  const ogDescription = input.ogDescription ?? input.description;

  return {
    // Plain string: the root layout template ('%s | مُضاعِف') wraps it.
    title: input.title,
    description: input.description,
    alternates: { canonical: input.path },
    openGraph: {
      title: ogTitle,
      description: ogDescription,
      url: input.path,
      siteName: BRAND.nameAr,
      locale: 'ar_SA',
      type: 'website',
      images: [{ ...OG_IMAGE }],
    },
    twitter: {
      card: 'summary_large_image',
      title: ogTitle,
      description: ogDescription,
      images: [OG_IMAGE.url],
    },
    ...(input.noIndex ? { robots: { index: false, follow: true } } : {}),
  };
}
