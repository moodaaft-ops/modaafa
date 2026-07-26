import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Sans_Arabic } from 'next/font/google';
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
    { media: '(prefers-color-scheme: dark)', color: '#0b1220' },
  ],
};

const themeScript = `
(function(){
  try {
    var t = localStorage.getItem('modaafa-theme');
    var m = window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (t === 'dark' || (!t && m)) document.documentElement.classList.add('dark');
  } catch (e) {}
})();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ar" dir="rtl" className={`${arabic.variable} w-full max-w-full overflow-x-hidden`} suppressHydrationWarning>
      <body className="w-full max-w-full overflow-x-hidden bg-background font-sans text-foreground antialiased">
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        {children}
      </body>
    </html>
  );
}
