import type { Metadata } from 'next';
import { TikTokPixel } from '@/lib/analytics/tiktok-pixel';
import { pageMetadata } from '@/lib/seo/site';

export const metadata: Metadata = pageMetadata({
  title: 'تسجيل الدخول',
  path: '/login',
  description: 'ادخل حسابك في مُضاعِف بحساب Google أو برابط يوصل بريدك، وكمّل من حيث وقفت مع حساب إعلانات جوجل.',
});

// The login page is a client component, so the pixel (which needs the request
// nonce) is mounted here, in the server layout that only ever wraps /login.
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <TikTokPixel pageView />
      {children}
    </>
  );
}
