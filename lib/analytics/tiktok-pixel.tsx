import { headers } from 'next/headers';
import { envValue } from '@/lib/platform/env';
import { NONCE_HEADER } from '@/lib/security/csp';
import { TikTokPixelEvents } from './tiktok-pixel-events';
import { planTikTokPixel, TIKTOK_PIXEL_ENV, type TikTokConversionEvent } from './tiktok';

/**
 * Loads the TikTok Pixel on the page that renders it — and nowhere else. Pages
 * opt in one by one; this is deliberately not mounted in a shared layout,
 * because the logged-in dashboard holds client account data.
 *
 * Renders nothing unless `TIKTOK_PIXEL_ID` is set. The id is read per request,
 * which works because the root layout already reads the nonce header and so
 * keeps the whole tree dynamic; it is never inlined at build time.
 *
 * The base snippet is an inline script, so it needs the request nonce exactly
 * like the theme script in the root layout. Under `'strict-dynamic'` that nonce
 * also covers the events.js script the snippet injects.
 */
export async function TikTokPixel({
  pageView = false,
  conversion,
}: {
  /** Report a PageView (`ttq.page()`) once this page mounts. */
  pageView?: boolean;
  /** Report a conversion, keyed per user so it dedups across reloads and devices. */
  conversion?: { event: TikTokConversionEvent; userId: string };
}) {
  const plan = planTikTokPixel(envValue(TIKTOK_PIXEL_ENV), { pageView, conversion });
  if (!plan) return null;

  const nonce = (await headers()).get(NONCE_HEADER) ?? undefined;

  return (
    <>
      <script nonce={nonce} dangerouslySetInnerHTML={{ __html: plan.snippet }} />
      <TikTokPixelEvents
        pageView={plan.pageView}
        event={plan.conversion?.event}
        eventId={plan.conversion?.eventId}
      />
    </>
  );
}
