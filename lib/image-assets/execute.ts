import { privateImageInAccount, storageImagePath } from './private-storage';
import { probeImage } from './probe';
import { createHash } from 'node:crypto';
import { escapeGaql, isRec, isStr, pickNum, pickStr, type GrowthCustomer } from '../growth/types';
import { resourceNamesFromMutate } from '../launch/execute';
import type { FetchDeps } from '../landing-check/fetch';
import { IMAGE_SLOTS, MAX_IMAGE_BYTES, SLOT_SPECS, meetsMinimum, ratioMatches, type ImageSlot } from './requirements';
import { fetchImage } from './fetch';

/**
 * create_image_assets: uploads images the merchant approved as ImageAssets. Nothing is generated
 * and nothing is cropped here: only an image that already fits its slot is uploaded, byte for byte.
 *
 * The card stores url + sha256 + size + slot. At execution the image is downloaded again through the
 * guarded fetcher and refused if its hash changed since the merchant looked at it.
 * Assets cannot be deleted in Google Ads, so the undo is "not reversible, nothing serves them":
 * an unused ImageAsset costs nothing and shows nowhere.
 */

export const MAX_IMAGES_PER_CARD = 8;
export const ASSET_NAME_PREFIX = 'مُضاعِف صورة';
const SHA_RE = /^[0-9a-f]{64}$/;
const ASSET_RE = /^customers\/\d+\/assets\/\d+$/;

export type ImageAssetItem = { url: string; sha256: string; width: number; height: number; bytes: number; slot: ImageSlot };
export type CreateImageAssetsParams = { images: ImageAssetItem[] };

export function validateCreateImageAssetsParams(raw: unknown): { ok: true; value: CreateImageAssetsParams } | { ok: false; code: string } {
  if (!isRec(raw) || !Array.isArray(raw.images)) return { ok: false, code: 'images' };
  if (raw.images.length < 1 || raw.images.length > MAX_IMAGES_PER_CARD) return { ok: false, code: 'images_count' };
  const out: ImageAssetItem[] = [];
  const seen = new Set<string>();
  for (const item of raw.images) {
    if (!isRec(item) || !isStr(item.url) || !(item.url.startsWith('https://') || /^storage:\/\/merchant-images\/\d{10}\/[0-9a-f-]{36}\/[0-9a-f]{64}\.(png|jpg)$/.test(item.url)) || item.url.length > 2000) return { ok: false, code: 'image_url' };
    if (!isStr(item.sha256) || !SHA_RE.test(item.sha256)) return { ok: false, code: 'image_hash' };
    const { width, height, bytes, slot } = item as Record<string, unknown>;
    if (!Number.isInteger(width) || !Number.isInteger(height) || !Number.isInteger(bytes)) return { ok: false, code: 'image_size' };
    if (!IMAGE_SLOTS.includes(slot as ImageSlot)) return { ok: false, code: 'image_slot' };
    const spec = SLOT_SPECS[slot as ImageSlot];
    if (!ratioMatches(width as number, height as number, spec) || !meetsMinimum(width as number, height as number, spec)) return { ok: false, code: 'image_fit' };
    if ((bytes as number) <= 0 || (bytes as number) > Math.min(spec.maxBytes, MAX_IMAGE_BYTES)) return { ok: false, code: 'image_bytes' };
    const key = `${item.sha256}:${slot}`;
    if (seen.has(key)) return { ok: false, code: 'image_duplicate' };
    seen.add(key);
    out.push({ url: item.url, sha256: item.sha256, width: width as number, height: height as number, bytes: bytes as number, slot: slot as ImageSlot });
  }
  return { ok: true, value: { images: out } };
}

export const imageAssetName = (item: Pick<ImageAssetItem, 'sha256' | 'slot'>) => `${ASSET_NAME_PREFIX} ${item.slot} ${item.sha256.slice(0, 8)}`;

export type ImageDeps = FetchDeps & { fetchStored?: (path: string) => Promise<Uint8Array> };

type Prepared = { item: ImageAssetItem; name: string; data: string; existing: string | null };

async function existingAsset(customer: GrowthCustomer, name: string): Promise<string | null> {
  const rows = await customer.query(`SELECT asset.resource_name FROM asset WHERE asset.name = '${escapeGaql(name)}' AND asset.type = 'IMAGE' LIMIT 1`);
  return rows[0] ? pickStr(rows[0], 'asset.resource_name') || null : null;
}

async function prepare(raw: unknown, customer: GrowthCustomer, deps: ImageDeps): Promise<Prepared[]> {
  const checked = validateCreateImageAssetsParams(raw);
  if (!checked.ok) throw new Error(`Image assets are malformed (${checked.code})`);
  const prepared: Prepared[] = [];
  for (const item of checked.value.images) {
    const path = storageImagePath(item.url);
    let fetched;
    if (path !== null) {
      const cid = String(customer.credentials?.customer_id ?? '').replace(/\D/g, '');
      if (!deps.fetchStored || !privateImageInAccount(item.url, cid)) throw new Error('Private image outside selected account');
      const bytes = await deps.fetchStored(path);
      const probe = probeImage(bytes);
      fetched = probe ? { ok: true as const, bytes, probe } : { ok: false as const, code: 'unreadable' };
    } else fetched = await fetchImage(item.url, deps);
    if (!fetched.ok) throw new Error(`Could not download an image again (${fetched.code}); nothing was uploaded.`);
    const hash = createHash('sha256').update(fetched.bytes).digest('hex');
    if (hash !== item.sha256) throw new Error('An image changed since you approved it; nothing was uploaded.');
    if (fetched.bytes.length !== item.bytes || !['png', 'jpeg'].includes(fetched.probe.format)) throw new Error('Image bytes or format changed');
    if (fetched.probe.width !== item.width || fetched.probe.height !== item.height) throw new Error('An image size changed since you approved it.');
    const name = imageAssetName(item);
    prepared.push({ item, name, data: Buffer.from(fetched.bytes).toString('base64'), existing: await existingAsset(customer, name) });
  }
  return prepared;
}

const operationsFor = (prepared: Prepared[]) =>
  prepared.filter((p) => !p.existing).map((p) => ({ asset_operation: { create: { name: p.name, type: 'IMAGE', image_asset: { data: p.data } } } }));

export async function validateCreateImageAssets(raw: unknown, customer: GrowthCustomer, deps: ImageDeps) {
  const prepared = await prepare(raw, customer, deps);
  const operations = operationsFor(prepared);
  if (operations.length > 0) await customer.mutateOperations(operations, { validateOnly: true });
  return { validate_only: 'passed' as const, to_create: operations.length, already_present: prepared.length - operations.length };
}

export async function executeCreateImageAssets(raw: unknown, customer: GrowthCustomer, customerId: string, deps: ImageDeps) {
  const prepared = await prepare(raw, customer, deps);
  const operations = operationsFor(prepared);
  const prefix = `customers/${customerId.replace(/\D/g, '')}/`;
  const created: string[] = [];
  if (operations.length > 0) {
    await customer.mutateOperations(operations, { validateOnly: true });
    const result = await customer.mutateOperations(operations);
    const names = resourceNamesFromMutate(result, operations.length).map((n) => n ?? '');
    if (names.length !== operations.length || names.some((n) => !ASSET_RE.test(n) || !n.startsWith(prefix))) {
      throw new Error('Google Ads did not return the created asset names.');
    }
    created.push(...names);
  }
  // Readback: each asset exists with the dimensions we sent.
  const mismatches: string[] = [];
  const assets: Array<{ slot: ImageSlot; resource_name: string; reused: boolean }> = [];
  let cursor = 0;
  for (const p of prepared) {
    const resource = p.existing ?? created[cursor++];
    assets.push({ slot: p.item.slot, resource_name: resource, reused: Boolean(p.existing) });
    try {
      const rows = await customer.query(
        `SELECT asset.resource_name, asset.image_asset.full_size.width_pixels, asset.image_asset.full_size.height_pixels FROM asset WHERE asset.resource_name = '${escapeGaql(resource)}' LIMIT 1`
      );
      if (!rows[0]) mismatches.push(`${p.item.slot}:missing`);
      else {
        const w = pickNum(rows[0], 'asset.image_asset.full_size.width_pixels');
        const h = pickNum(rows[0], 'asset.image_asset.full_size.height_pixels');
        if (w !== p.item.width || h !== p.item.height) mismatches.push(`${p.item.slot}:size`);
      }
    } catch {
      mismatches.push(`${p.item.slot}:readback_failed`);
    }
  }
  return {
    assets,
    validate_only: 'passed' as const,
    readback: { ok: mismatches.length === 0, mismatches },
    rollback_payload: {
      reversible: false,
      action_type: 'growth_not_reversible',
      note: 'assets_cannot_be_deleted_unused_assets_do_not_serve',
      retained_resources: assets.map((a) => a.resource_name),
      resource_names: created,
    },
  };
}
