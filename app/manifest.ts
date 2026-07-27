import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'مُضاعِف | Modaafa Ads AI',
    short_name: 'مُضاعِف',
    description: 'مساحة عمل ذكية لإدارة إعلانات Google: فحص وتوصيات ومساعد ذكي مع موافقتك قبل أي تعديل.',
    // '/' rather than '/dashboard': an installed PWA cold launch would
    // otherwise always begin with a login redirect.
    start_url: '/',
    display: 'standalone',
    dir: 'rtl',
    lang: 'ar',
    background_color: '#f8fafc',
    theme_color: '#064e3b',
    icons: [
      { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml' },
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
