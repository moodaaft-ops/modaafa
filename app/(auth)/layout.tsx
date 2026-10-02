import type { Metadata } from 'next';
import { TikTokPixel } from '@/lib/analytics/tiktok-pixel';

export const metadata: Metadata = {
  title: 'تسجيل الدخول',
};

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
