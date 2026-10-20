import { createHash } from 'node:crypto';
import { probeImage } from './probe';
import { validateCreateImageAssetsParams, type ImageAssetItem } from './execute';
import type { ImageSlot } from './requirements';
export const IMAGE_BUCKET = 'merchant-images';
export const DEVICE_IMAGE_MAX_BYTES = 4_000_000;
export const deviceImageUploadEnabled = (env: NodeJS.ProcessEnv = process.env) => env.IMAGE_DEVICE_UPLOAD_ENABLED === 'true';
const PATH = /^(\d{10})\/[0-9a-f-]{36}\/[0-9a-f]{64}\.(png|jpg)$/;
export const storageImagePath = (url: string) => url.startsWith(`storage://${IMAGE_BUCKET}/`) ? url.slice(`storage://${IMAGE_BUCKET}/`.length) : null;
export function privateImageInAccount(url: string, customerId: string) {
  const path = storageImagePath(url); return path !== null && PATH.exec(path)?.[1] === customerId.replace(/\D/g, '');
}
export function deviceImageItem(bytes: Uint8Array, slot: ImageSlot, customerId: string, userId: string): ImageAssetItem | null {
  if (bytes.length > DEVICE_IMAGE_MAX_BYTES || !/^\d{10}$/.test(customerId) || !/^[0-9a-f-]{36}$/.test(userId)) return null;
  const probe = probeImage(bytes);
  if (!probe || !['png', 'jpeg'].includes(probe.format)) return null;
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const path = `${customerId}/${userId}/${sha256}.${probe.format === 'png' ? 'png' : 'jpg'}`;
  const item: ImageAssetItem = { url: `storage://${IMAGE_BUCKET}/${path}`, sha256, width: probe.width, height: probe.height, bytes: bytes.length, slot };
  return validateCreateImageAssetsParams({ images: [item] }).ok ? item : null;
}
