import type { Metadata } from 'next';
import { cookies, headers } from 'next/headers';
import { RegisterForm, type InAppOffer } from './register-form';
import { REGISTRATION_CONSENT_TEXT } from '@/lib/registration/consent';
import {
  ATTRIBUTION_COOKIE,
  extractAttribution,
  hasMarketingSignal,
  parseAttributionCookie,
} from '@/lib/registration/attribution';
import { normalizePartnerCode, partnersEnabled, REF_COOKIE } from '@/lib/partners/config';
import {
  IN_APP_LABEL_AR,
  buildOpenInBrowserHref,
  buildReopenUrl,
  detectInAppBrowser,
} from '@/lib/registration/in-app-browser';
import { requireAppUrl } from '@/lib/platform/env';
import { pageMetadata } from '@/lib/seo/site';

export const metadata: Metadata = pageMetadata({
  title: 'إنشاء حساب',
  path: '/register',
  description: 'أنشئ حسابك في مُضاعِف بالاسم والبريد والجوال، ثم اربط حساب إعلانات جوجل وشوف أول فحص مجاناً وبدون بطاقة.',
});

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

async function inAppOffer(searchParams: SearchParams): Promise<InAppOffer | null> {
  const h = await headers();
  const inApp = detectInAppBrowser(h.get('user-agent'));
  if (!inApp) return null;

  // The same host the visitor is on (a preview stays a preview). The link only
  // goes back to this visitor, so a forged Host header can only fool its sender.
  const host = h.get('x-forwarded-host') ?? h.get('host');
  let appUrl: string;
  try {
    appUrl = host ? `${h.get('x-forwarded-proto') ?? 'https'}://${host}` : requireAppUrl();
    new URL(appUrl);
  } catch {
    return null;
  }

  // Parameters on this very request win (middleware only writes the cookie on
  // the response, so a visitor who lands straight here has no cookie yet).
  const sp = await searchParams;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(sp)) if (typeof value === 'string') query.set(key, value);
  const fromQuery = extractAttribution(query, '/register');
  const attribution = hasMarketingSignal(fromQuery)
    ? fromQuery
    : parseAttributionCookie((await cookies()).get(ATTRIBUTION_COOKIE)?.value);

  const refCode = partnersEnabled()
    ? normalizePartnerCode(sp.ref) ?? normalizePartnerCode((await cookies()).get(REF_COOKIE)?.value)
    : null;
  const target = buildReopenUrl(appUrl, '/register', attribution, refCode);
  return {
    appLabel: IN_APP_LABEL_AR[inApp.app],
    href: buildOpenInBrowserHref(target, inApp.os),
    url: target.toString(),
  };
}

export default async function RegisterPage({ searchParams }: { searchParams: SearchParams }) {
  return <RegisterForm consentText={REGISTRATION_CONSENT_TEXT} inApp={await inAppOffer(searchParams)} />;
}
