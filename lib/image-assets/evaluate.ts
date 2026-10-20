import { IMAGE_SLOTS, MAX_IMAGE_BYTES, SLOT_SPECS, meetsMinimum, ratioMatches, SLOT_LABEL_AR, type ImageSlot } from './requirements';
import type { ImageFormat } from './probe';
import type { CandidateSource } from './extract';

export type CropProposal = { slot: ImageSlot; x: number; y: number; width: number; height: number; output_width: number; output_height: number };

export type ImageEvaluation = {
  url: string;
  width: number;
  height: number;
  bytes: number;
  format: ImageFormat;
  sha256: string;
  /** Slots the image can be uploaded to as it is. */
  fits: ImageSlot[];
  /** Slots reachable by cropping the image (a proposal only; nothing is cropped here). */
  crops: CropProposal[];
  issues_ar: string[];
};

const ACCEPTED: readonly ImageFormat[] = ['png', 'jpeg'];

export function looksLikeLogo(url: string, alt: string, source: CandidateSource): boolean {
  return source === 'icon' || /logo|لوجو|شعار|brand/i.test(`${url} ${alt}`);
}

/** The largest centered crop of the wanted ratio, or null when the result is below the slot minimum. */
export function centerCrop(width: number, height: number, slot: ImageSlot): CropProposal | null {
  const spec = SLOT_SPECS[slot];
  let cw = width;
  let ch = Math.round(width / spec.ratio);
  if (ch > height) {
    ch = height;
    cw = Math.round(height * spec.ratio);
  }
  if (!meetsMinimum(cw, ch, spec)) return null;
  return {
    slot,
    x: Math.floor((width - cw) / 2),
    y: Math.floor((height - ch) / 2),
    width: cw,
    height: ch,
    output_width: cw,
    output_height: ch,
  };
}

export function evaluateImage(input: {
  url: string; width: number; height: number; bytes: number; format: ImageFormat; sha256: string; source: CandidateSource; alt: string;
}): ImageEvaluation {
  const issues: string[] = [];
  const out: ImageEvaluation = {
    url: input.url, width: input.width, height: input.height, bytes: input.bytes, format: input.format, sha256: input.sha256,
    fits: [], crops: [], issues_ar: issues,
  };
  if (!ACCEPTED.includes(input.format)) {
    issues.push('نوع الصورة غير مدعوم. المقبول JPG أو PNG');
    return out;
  }
  if (input.bytes > MAX_IMAGE_BYTES) {
    issues.push('حجم الصورة أكبر من 5 ميجا');
    return out;
  }
  const logo = looksLikeLogo(input.url, input.alt, input.source);
  for (const slot of IMAGE_SLOTS) {
    if (slot === 'logo' && !logo) continue;
    if (slot !== 'logo' && logo) continue; // a logo is not a hero image
    const spec = SLOT_SPECS[slot];
    if (input.bytes > spec.maxBytes) {
      if (slot === 'logo') issues.push('الشعار أكبر من 150 كيلو');
      continue;
    }
    if (ratioMatches(input.width, input.height, spec) && meetsMinimum(input.width, input.height, spec)) {
      out.fits.push(slot);
    } else {
      const crop = centerCrop(input.width, input.height, slot);
      if (crop && input.bytes <= spec.maxBytes) out.crops.push(crop);
    }
  }
  if (out.fits.length === 0 && out.crops.length === 0) issues.push('الصورة صغيرة أو مقاسها ما يناسب أي خانة');
  return out;
}

export const slotLabel = (slot: ImageSlot) => SLOT_LABEL_AR[slot];
