import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import { IBM_Plex_Mono, IBM_Plex_Sans_Arabic, Reem_Kufi } from 'next/font/google';
import { NONCE_HEADER } from '@/lib/security/csp';
import './globals.css';

const arabic = IBM_Plex_Sans_Arabic({
  // Load the Latin subset too: customer IDs, emails, URLs and plan names are
  // LTR and were swapping in late (and reflowing) because only Arabic was
  // preloaded. Weight 300 is dropped — nothing in the app uses it.
  subsets: ['arabic', 'latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-arabic',
  display: 'swap',
  fallback: ['system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
});

// Display face: square-leaning Kufi for headlines, matching the wordmark's
// geometry. Used only for headings; body and controls stay on the UI face.
const display = Reem_Kufi({
  subsets: ['arabic', 'latin'],
  weight: ['500', '600', '700'],
  variable: '--font-display',
  display: 'swap',
  preload: false,
  fallback: ['system-ui', 'sans-serif'],
});

// Numbers and data: Latin digits in a monospace face, per identity v1.0.
const mono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-mono',
  display: 'swap',
  fallback: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
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
      { url: '/favicon.ico?v=20261007', sizes: '48x48' },
      { url: '/favicon.svg?v=20261007', type: 'image/svg+xml' },
    ],
    shortcut: '/favicon.ico?v=20261007',
    apple: '/apple-touch-icon.png?v=20261007',
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
        alt: 'مُضاعِف - Modaafa Ads AI',
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
    { media: '(prefers-color-scheme: light)', color: '#F4F2EC' },
    { media: '(prefers-color-scheme: dark)', color: '#0E1426' },
  ],
};

// Light is the default theme (identity v1.0). <html> ships without the `dark`
// class; this script ADDS it only when the user explicitly chose dark, and it
// runs before paint so there is no flash.
const themeScript = `
(function(){
  try {
    if (localStorage.getItem('modaafa-theme') === 'dark') {
      document.documentElement.classList.add('dark');
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
    <html lang="ar" dir="rtl" className={`${arabic.variable} ${display.variable} ${mono.variable} w-full max-w-full overflow-x-hidden`} suppressHydrationWarning>
      <body className="w-full max-w-full overflow-x-hidden bg-background font-sans text-foreground antialiased">
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: themeScript }} />
        {children}
      </body>
    </html>
  );
}
