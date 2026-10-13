import { TikTokPixel } from '@/lib/analytics/tiktok-pixel';

/**
 * Reports CompleteRegistration from the browser on /welcome. The event id is
 * built from the user id, the same way the server event is, so TikTok merges
 * the two into one conversion. Kept in its own file so /welcome can be
 * redesigned without touching the tracking.
 */
export function RegistrationPixel({ userId }: { userId: string }) {
  return <TikTokPixel conversion={{ event: 'CompleteRegistration', userId }} />;
}
