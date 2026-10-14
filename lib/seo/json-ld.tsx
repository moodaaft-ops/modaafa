import { AGENCY_URL, BRAND, ENTITY_IDS, POSITIONING_AR, SITE_URL } from '@/lib/seo/site';

/**
 * Renders one JSON-LD block. `<` is escaped so a string value can never close
 * the script element early (`</script>` inside a name, for example).
 */
export function JsonLd({ data, nonce }: { data: Record<string, unknown>; nonce?: string }) {
  return (
    <script
      type="application/ld+json"
      nonce={nonce}
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, '\\u003c') }}
    />
  );
}

/**
 * Sitewide entity graph: the website, the agency organization behind it, the
 * founder, and the application. Rendered once in the root layout. Prices are
 * deliberately absent here; a page that shows prices adds its own `offers`.
 */
export function siteGraph(): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebSite',
        '@id': ENTITY_IDS.website,
        name: BRAND.nameAr,
        alternateName: [BRAND.nameEn, BRAND.appName],
        url: `${SITE_URL}/`,
        inLanguage: 'ar',
        publisher: { '@id': ENTITY_IDS.org },
      },
      {
        '@type': 'Organization',
        '@id': ENTITY_IDS.org,
        name: BRAND.agencyNameAr,
        alternateName: [BRAND.agencyNameEn, BRAND.nameEn],
        legalName: BRAND.legalName,
        url: AGENCY_URL,
        logo: `${SITE_URL}/brand/png/modaafa-symbol-primary-1024.png`,
        identifier: {
          '@type': 'PropertyValue',
          propertyID: 'الرقم الوطني الموحد',
          value: BRAND.unifiedNumber,
        },
        founder: { '@id': ENTITY_IDS.founder },
        areaServed: { '@type': 'Country', name: 'السعودية' },
        address: { '@type': 'PostalAddress', addressCountry: 'SA' },
        email: BRAND.email,
        contactPoint: [
          {
            '@type': 'ContactPoint',
            contactType: 'customer support',
            email: BRAND.email,
            telephone: BRAND.whatsappIntl,
            areaServed: 'SA',
            availableLanguage: ['ar', 'en'],
          },
        ],
      },
      {
        '@type': 'Person',
        '@id': ENTITY_IDS.founder,
        name: BRAND.founderAr,
        alternateName: BRAND.founderEn,
        jobTitle: BRAND.founderTitle,
        worksFor: { '@id': ENTITY_IDS.org },
        sameAs: [...BRAND.founderSameAs],
      },
      {
        '@type': 'SoftwareApplication',
        '@id': ENTITY_IDS.app,
        name: BRAND.nameAr,
        alternateName: [BRAND.nameEn, BRAND.appName],
        url: `${SITE_URL}/`,
        applicationCategory: 'BusinessApplication',
        operatingSystem: 'Web',
        inLanguage: 'ar',
        description: POSITIONING_AR,
        publisher: { '@id': ENTITY_IDS.org },
        creator: { '@id': ENTITY_IDS.founder },
      },
    ],
  };
}

export function SiteStructuredData({ nonce }: { nonce?: string }) {
  return <JsonLd data={siteGraph()} nonce={nonce} />;
}
