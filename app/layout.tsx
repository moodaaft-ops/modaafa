import type { Metadata } from 'next';
import { IBM_Plex_Sans_Arabic } from 'next/font/google';
import './globals.css';

const arabic = IBM_Plex_Sans_Arabic({
  subsets: ['arabic'],
  weight: ['300', '400', '500', '600', '700'],
  variable: '--font-arabic',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'مُضاعِف | Modaafa - الميديا باير الذكي لإعلانات جوجل',
  description: 'منصة ذكاء اصطناعي تدير حملاتك الإعلانية على جوجل بالكامل',
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? 'https://modaafa.com'),
  openGraph: {
    title: 'مُضاعِف - الميديا باير الذكي',
    description: 'بديل كامل عن الميديا باير - مدعوم بالذكاء الاصطناعي',
    type: 'website',
    locale: 'ar_SA',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ar" dir="rtl" className={arabic.variable}>
      <body className="font-sans antialiased bg-ink-50 text-ink-900">{children}</body>
    </html>
  );
}
