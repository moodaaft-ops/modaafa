import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import { IBM_Plex_Sans_Arabic } from 'next/font/google';
import { NONCE_HEADER } from '@/lib/security/csp';
import './globals.css';

const arabic = IBM_Plex_Sans_Arabic({
  subsets: ['arabic'],
  weight: ['300', '400', '500', '600', '700'],
  variable: '--font-arabic',
  display: 'swap',
});

export const metadata: Metadata = {
  title: {
    default: 'مُضاعِف | Modaafa - الميديا باير الذكي لإعلانات جوجل',
    template: '%s | مُضاعِف',
  },
  description: 'منصة عربية لربط حسابات Google Ads وتحليلها واقتراح تحسينات تمر عبر موافقتك قبل التنفيذ.',
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? 'https://ai.modaafa.com'),
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: '48x48' },
      { url: '/favicon.svg', type: 'image/svg+xml' },
    ],
    shortcut: '/favicon.ico',
    apple: '/apple-touch-icon.png',
  },
  applicationName: 'Modaafa Ads AI',
  manifest: '/manifest.webmanifest',
  openGraph: {
    title: 'مُضاعِف - الميديا باير الذكي',
    description: 'فحص وتوصيات ومساعد ذكي لإعلانات Google، مع موافقة واضحة قبل أي تعديل.',
    type: 'website',
    locale: 'ar_SA',
    siteName: 'مُضاعِف',
    // SVG is NOT a valid OpenGraph image for Facebook, WhatsApp, X or
    // LinkedIn — every shared link rendered with no preview at all.
    images: [
      {
        url: '/og-image.png',
        width: 1200,
        height: 630,
        alt: 'Modaafa Ads AI',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'مُضاعِف - الميديا باير الذكي',
    description: 'فحص وتوصيات ومساعد ذكي لإعلانات Google، مع موافقة واضحة قبل أي تعديل.',
    images: ['/og-image.png'],
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f8fafc' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0c11' },
  ],
};

// Dark is the product's default, so <html> ships with the `dark` class from
// the server and there is no first-paint flash. This script only REMOVES it
// for a user who has explicitly chosen light — adding it here instead would
// mean the server-rendered HTML was light for one frame on every load.
const themeScript = `
(function(){
  try {
    if (localStorage.getItem('modaafa-theme') === 'light') {
      document.documentElement.classList.remove('dark');
    }
  } catch (e) {}
})();
`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Reading the nonce here is also what opts the whole tree out of static
  // rendering. That is the accepted cost of a nonce CSP: a prerendered page is
  // served from cache with whatever nonce it was built with, which no later
  // response header would match, so the theme script would be blocked on every
  // hit but the first.
  const nonce = (await headers()).get(NONCE_HEADER) ?? undefined;

  return (
    <html lang="ar" dir="rtl" className={`${arabic.variable} dark w-full max-w-full overflow-x-hidden`} suppressHydrationWarning>
      <body className="w-full max-w-full overflow-x-hidden bg-background font-sans text-foreground antialiased">
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: themeScript }} />
        {children}
      </body>
    </html>
  );
}
