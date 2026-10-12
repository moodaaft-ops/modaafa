/**
 * When the popup may appear. Pure, so it is tested without a browser.
 *
 * Desktop: the mouse leaves through the top edge of the window, after the
 * visitor has had a few seconds with the page.
 *
 * Phone: there is no real "leaving", so two softer signals stand in. A fast
 * flick back up the page after reading some of it, or 40 seconds on the page
 * after reading a quarter of it. Both show a bottom bar, never a full-screen
 * overlay.
 */

export const DESKTOP_MIN_MS_ON_PAGE = 6000;
export const PHONE_IDLE_MS = 40_000;
export const PHONE_MIN_DEPTH_FOR_FLICK = 0.35;
export const PHONE_MIN_DEPTH_FOR_IDLE = 0.25;
export const FLICK_DISTANCE_PX = 500;
export const FLICK_WINDOW_MS = 700;

/** True when the pointer left the document through the top edge. */
export function leftThroughTop(event: { clientY: number; relatedTarget: unknown }) {
  return event.relatedTarget === null && event.clientY <= 0;
}

export function desktopMayOpen(msOnPage: number) {
  return msOnPage >= DESKTOP_MIN_MS_ON_PAGE;
}

/** Reading depth 0..1: how far the bottom of the screen has travelled down the page. */
export function readingDepth(scrollY: number, viewportHeight: number, documentHeight: number) {
  if (documentHeight <= 0) return 0;
  return Math.min(1, Math.max(0, (scrollY + viewportHeight) / documentHeight));
}

export class FlickDetector {
  private samples: Array<{ y: number; t: number }> = [];
  private deepest = 0;

  /** Feed every scroll event. Returns true once, at the moment the flick completes. */
  push(sample: { y: number; t: number; viewportHeight: number; documentHeight: number }) {
    this.deepest = Math.max(this.deepest, readingDepth(sample.y, sample.viewportHeight, sample.documentHeight));
    this.samples.push({ y: sample.y, t: sample.t });
    this.samples = this.samples.filter((s) => sample.t - s.t <= FLICK_WINDOW_MS);
    if (this.deepest < PHONE_MIN_DEPTH_FOR_FLICK) return false;
    const highest = Math.max(...this.samples.map((s) => s.y));
    return highest - sample.y >= FLICK_DISTANCE_PX;
  }

  get maxDepth() {
    return this.deepest;
  }
}

export function phoneIdleMayOpen(msOnPage: number, maxDepth: number) {
  return msOnPage >= PHONE_IDLE_MS && maxDepth >= PHONE_MIN_DEPTH_FOR_IDLE;
}
