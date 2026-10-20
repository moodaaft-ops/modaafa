/**
 * Image requirements for Demand Gen (and Performance Max, which uses the same
 * ratios). Source: Google Ads Help «Demand Gen campaign asset specs»
 * (support.google.com/google-ads/answer/13704860) and google-ads-titan
 * references/pmax-shopping-demandgen.md «المقاسات».
 *
 *   marketing  1.91:1   min 600x314     recommended 1200x628
 *   square     1:1      min 300x300     recommended 1200x1200
 *   portrait   4:5      min 480x600     recommended 960x1200
 *   logo       1:1      min 144x144     recommended 1200x1200, file up to 150 KB
 * Images: JPG or PNG, up to 5 MB. (9:16 is also accepted by Demand Gen for Shorts; it has no slot
 * in the ad types built here, so it is not offered.)
 */

export type ImageSlot = 'marketing' | 'square' | 'portrait' | 'logo';

export type SlotSpec = {
  slot: ImageSlot;
  ratio: number;
  ratioLabel: string;
  minWidth: number;
  minHeight: number;
  recommendedWidth: number;
  recommendedHeight: number;
  maxBytes: number;
};

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_LOGO_BYTES = 150 * 1024;
/** Google accepts a ratio within 1 percent of the nominal one. */
export const RATIO_TOLERANCE = 0.01;

export const SLOT_SPECS: Readonly<Record<ImageSlot, SlotSpec>> = {
  marketing: {
    slot: 'marketing', ratio: 1.91, ratioLabel: '1.91:1', minWidth: 600, minHeight: 314,
    recommendedWidth: 1200, recommendedHeight: 628, maxBytes: MAX_IMAGE_BYTES,
  },
  square: {
    slot: 'square', ratio: 1, ratioLabel: '1:1', minWidth: 300, minHeight: 300,
    recommendedWidth: 1200, recommendedHeight: 1200, maxBytes: MAX_IMAGE_BYTES,
  },
  portrait: {
    slot: 'portrait', ratio: 0.8, ratioLabel: '4:5', minWidth: 480, minHeight: 600,
    recommendedWidth: 960, recommendedHeight: 1200, maxBytes: MAX_IMAGE_BYTES,
  },
  logo: {
    slot: 'logo', ratio: 1, ratioLabel: '1:1', minWidth: 144, minHeight: 144,
    recommendedWidth: 1200, recommendedHeight: 1200, maxBytes: MAX_LOGO_BYTES,
  },
};

export const SLOT_LABEL_AR: Readonly<Record<ImageSlot, string>> = {
  marketing: 'صورة أفقية',
  square: 'صورة مربعة',
  portrait: 'صورة عمودية',
  logo: 'شعار',
};

export const IMAGE_SLOTS: readonly ImageSlot[] = ['marketing', 'square', 'portrait', 'logo'];

export function ratioMatches(width: number, height: number, spec: SlotSpec): boolean {
  if (!(width > 0) || !(height > 0)) return false;
  return Math.abs(width / height / spec.ratio - 1) <= RATIO_TOLERANCE;
}

export function meetsMinimum(width: number, height: number, spec: SlotSpec): boolean {
  return width >= spec.minWidth && height >= spec.minHeight;
}

/** Slot for which the pixel size is exactly right (ratio and minimum). */
export function slotsFor(width: number, height: number): ImageSlot[] {
  return IMAGE_SLOTS.filter((slot) => ratioMatches(width, height, SLOT_SPECS[slot]) && meetsMinimum(width, height, SLOT_SPECS[slot]));
}
