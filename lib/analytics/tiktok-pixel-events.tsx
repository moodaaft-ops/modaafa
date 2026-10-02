'use client';

import { useEffect } from 'react';
import { claimTikTokEvent, type TikTokConversionEvent } from './tiktok';

type TikTokQueue = {
  page: () => void;
  track: (event: string, params?: Record<string, unknown>, options?: { event_id?: string }) => void;
};

declare global {
  interface Window {
    ttq?: TikTokQueue;
  }
}

function safeLocalStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Fires the page's TikTok events once it has mounted. The inline base snippet
 * (see `tiktok-pixel.tsx`) has already defined the `window.ttq` queue by then,
 * so calls made before events.js finishes loading are replayed by TikTok.
 *
 * Analytics must never break a page: a missing `ttq` (blocked by an extension)
 * is a silent no-op and every call is isolated from React.
 */
export function TikTokPixelEvents({
  pageView,
  event,
  eventId,
}: {
  pageView: boolean;
  event?: TikTokConversionEvent;
  eventId?: string;
}) {
  useEffect(() => {
    const ttq = window.ttq;
    if (!ttq) return;
    try {
      if (pageView) ttq.page();
      // No parameters on purpose — no value, no email, no phone.
      if (event && eventId && claimTikTokEvent(safeLocalStorage(), eventId)) {
        ttq.track(event, {}, { event_id: eventId });
      }
    } catch {
      // Swallow: tracking is best-effort.
    }
  }, [pageView, event, eventId]);

  return null;
}
