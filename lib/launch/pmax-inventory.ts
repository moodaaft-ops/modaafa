import { LEAD_ACTION_PRIMARY_MIN_30D, LEAD_CONVERSION_ACTION_NAME } from '../measurement/goals';
import { imageFits, youtubeIdOf, type PmaxImageSlot, type PmaxInventory } from './pmax';

/**
 * Read-only lookups for the Performance Max launch: what the account already
 * holds (images, YouTube videos, customer lists, custom audiences) and whether
 * the offline upload for lead generation is in place. Used when proposing and
 * again, for the chosen assets only, right before the build. A failed read is
 * "unknown": nothing here guesses.
 */

export interface GaqlReader {
  query(gaql: string): Promise<any[]>;
}

const get = (row: any, dotted: string): unknown => {
  let cursor = row;
  for (const part of dotted.split('.')) {
    if (cursor === null || cursor === undefined) return undefined;
    const camel = part.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    cursor = cursor[camel] !== undefined ? cursor[camel] : cursor[part];
  }
  return cursor;
};
const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown) => (v === undefined || v === null ? '' : String(v));

const INVENTORY_LIMIT = 500;
const escapeGaql = (value: string) => value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

export async function readPmaxInventory(customer: GaqlReader): Promise<PmaxInventory> {
  const safe = async (gaql: string) => {
    try {
      return await customer.query(gaql);
    } catch {
      return [];
    }
  };
  const [images, videos, lists, custom] = await Promise.all([
    safe(
      `SELECT asset.resource_name, asset.image_asset.full_size.width_pixels, asset.image_asset.full_size.height_pixels FROM asset WHERE asset.type = 'IMAGE' LIMIT ${INVENTORY_LIMIT}`
    ),
    safe(`SELECT asset.resource_name, asset.youtube_video_asset.youtube_video_id FROM asset WHERE asset.type = 'YOUTUBE_VIDEO' LIMIT ${INVENTORY_LIMIT}`),
    safe(`SELECT user_list.resource_name, user_list.name FROM user_list WHERE user_list.membership_status = 'OPEN' LIMIT ${INVENTORY_LIMIT}`),
    safe(`SELECT custom_audience.resource_name, custom_audience.name FROM custom_audience WHERE custom_audience.status = 'ENABLED' LIMIT ${INVENTORY_LIMIT}`),
  ]);
  return {
    images: images
      .map((row) => ({
        resource_name: str(get(row, 'asset.resource_name')),
        width: num(get(row, 'asset.image_asset.full_size.width_pixels')),
        height: num(get(row, 'asset.image_asset.full_size.height_pixels')),
      }))
      .filter((i) => i.resource_name && i.width > 0 && i.height > 0),
    videos: videos
      .map((row) => ({ resource_name: str(get(row, 'asset.resource_name')), youtube_id: str(get(row, 'asset.youtube_video_asset.youtube_video_id')) }))
      .filter((v) => v.resource_name && youtubeIdOf(v.youtube_id)),
    user_lists: lists
      .map((row) => ({ resource_name: str(get(row, 'user_list.resource_name')), name: str(get(row, 'user_list.name')) }))
      .filter((l) => l.resource_name),
    custom_audiences: custom
      .map((row) => ({ resource_name: str(get(row, 'custom_audience.resource_name')), name: str(get(row, 'custom_audience.name')) }))
      .filter((c) => c.resource_name),
  };
}

/** Which slots an image of this size can fill (for the merchant's picker and for tests). */
export function slotsForImage(width: number, height: number): PmaxImageSlot[] {
  return (['marketing', 'square', 'portrait', 'logo', 'landscape_logo'] as const).filter((slot) => imageFits(slot, width, height));
}

export type OfflineUploadRow = { name: string; type: string; status: string; primary: boolean | null; conversions30d: number };

export function offlineUploadInPlace(rows: OfflineUploadRow[]): boolean {
  return rows.some(
    (r) =>
      r.type === 'UPLOAD_CLICKS' &&
      r.name === LEAD_CONVERSION_ACTION_NAME &&
      r.status === 'ENABLED' &&
      r.primary === true &&
      r.conversions30d >= LEAD_ACTION_PRIMARY_MIN_30D
  );
}

/** True only when the uploaded lead action is enabled, primary and has results. Any read failure is null (unknown). */
export async function readOfflineUploadInPlace(customer: GaqlReader): Promise<boolean | null> {
  try {
    const rows = await customer.query(
      `SELECT conversion_action.name, conversion_action.type, conversion_action.status, conversion_action.primary_for_goal, metrics.all_conversions FROM conversion_action WHERE conversion_action.type = 'UPLOAD_CLICKS' AND conversion_action.status = 'ENABLED' AND segments.date DURING LAST_30_DAYS`
    );
    const byName = new Map<string, OfflineUploadRow>();
    for (const row of rows) {
      const name = str(get(row, 'conversion_action.name'));
      const prev = byName.get(name);
      byName.set(name, {
        name,
        type: str(get(row, 'conversion_action.type')),
        status: str(get(row, 'conversion_action.status')),
        primary: (get(row, 'conversion_action.primary_for_goal') as boolean | undefined) ?? null,
        conversions30d: (prev?.conversions30d ?? 0) + num(get(row, 'metrics.all_conversions')),
      });
    }
    return offlineUploadInPlace([...byName.values()]);
  } catch {
    return null;
  }
}

/** Chosen assets only: do they still exist with the sizes the plan was built on. */
export async function readChosenAssets(customer: GaqlReader, names: string[]) {
  if (names.length === 0) return [];
  const list = names.map((n) => `'${escapeGaql(n)}'`).join(', ');
  const rows = await customer.query(
    `SELECT asset.resource_name, asset.image_asset.full_size.width_pixels, asset.image_asset.full_size.height_pixels FROM asset WHERE asset.resource_name IN (${list})`
  );
  return rows.map((row) => ({
    resource_name: str(get(row, 'asset.resource_name')),
    width: num(get(row, 'asset.image_asset.full_size.width_pixels')),
    height: num(get(row, 'asset.image_asset.full_size.height_pixels')),
  }));
}
