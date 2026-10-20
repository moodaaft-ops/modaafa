import { randomBytes } from 'node:crypto';
import type { StorePlatform } from './orders';

/** `<platform>~<192 bits>`. The platform is a routing hint; the stored oauth_states row is what is trusted. */
const PATTERN = /^(salla|zid|shopify)~([0-9a-f]{48})$/;

/** Platforms that connect through the generic redirect routes. Shopify has its own (per-shop) routes. */
export function isStorePlatform(v: unknown): v is 'salla' | 'zid' {
  return v === 'salla' || v === 'zid';
}
export function newStoreState(platform: StorePlatform, random: () => Buffer = () => randomBytes(24)): string {
  return `${platform}~${random().toString('hex')}`;
}
export function parseStoreState(state: unknown): { platform: StorePlatform } | null {
  if (typeof state !== 'string') return null;
  const m = PATTERN.exec(state);
  return m ? { platform: m[1] as StorePlatform } : null;
}
export function storePurpose(platform: StorePlatform): 'store_salla' | 'store_zid' | 'store_shopify' {
  return platform === 'salla' ? 'store_salla' : platform === 'zid' ? 'store_zid' : 'store_shopify';
}
export function storeCallbackRedirect(platform: StorePlatform | null, outcome: string): string {
  const q = new URLSearchParams({ store: outcome });
  if (platform) q.set('platform', platform);
  return `/settings?${q.toString()}`;
}
