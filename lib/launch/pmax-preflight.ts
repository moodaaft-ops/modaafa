import { PMAX_IMAGE_RULES, imageFits, type PmaxImageSlot } from './pmax';
import { readChosenAssets, type GaqlReader } from './pmax-inventory';
import type { LaunchPlan } from './types';

/**
 * The reads a Performance Max build depends on, right before the mutate: the
 * Merchant Center id and feed label (retail), the chosen images still exist at
 * the sizes the plan was built on, the chosen audiences are usable, and the
 * video assets the account already has. A plan is data from the database and
 * the account may have changed since the merchant approved it.
 */

export type PmaxPreflight =
  | { ok: true; merchantId: number | null; feedLabel: string | null; reusableVideos: Record<string, string> }
  | { ok: false; code: 'merchant_missing' | 'pmax_assets_changed'; message: string };

const get = (row: any, dotted: string): unknown => {
  let cursor = row;
  for (const part of dotted.split('.')) {
    if (cursor === null || cursor === undefined) return undefined;
    const camel = part.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    cursor = cursor[camel] !== undefined ? cursor[camel] : cursor[part];
  }
  return cursor;
};
const escapeGaql = (value: string) => value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

export async function readPmaxPreflight(plan: LaunchPlan, customer: GaqlReader): Promise<PmaxPreflight> {
  const build = plan.pmax?.build;
  if (!build) return { ok: false, code: 'pmax_assets_changed', message: 'The plan has no asset group.' };

  let merchantId: number | null = null;
  let feedLabel: string | null = null;
  if (build.retail) {
    // shopping_product exposes both the Merchant Center id and the feed label of the linked feed.
    try {
      const rows = await customer.query('SELECT shopping_product.merchant_center_id, shopping_product.feed_label FROM shopping_product LIMIT 1');
      const id = Number(get(rows[0], 'shopping_product.merchant_center_id'));
      if (Number.isFinite(id) && id > 0) merchantId = id;
      const label = get(rows[0], 'shopping_product.feed_label');
      if (typeof label === 'string' && label) feedLabel = label;
    } catch {
      merchantId = null;
    }
    if (!merchantId) {
      try {
        const rows = await customer.query("SELECT campaign.shopping_setting.merchant_id FROM campaign WHERE campaign.status != 'REMOVED' LIMIT 1000");
        for (const row of rows) {
          const id = Number(get(row, 'campaign.shopping_setting.merchant_id'));
          if (Number.isFinite(id) && id > 0) {
            merchantId = id;
            break;
          }
        }
      } catch {
        merchantId = null;
      }
    }
    if (!merchantId) return { ok: false, code: 'merchant_missing', message: 'No Merchant Center account is linked to this Google Ads account.' };
  }

  // Images: each chosen asset must still exist and still fit its slot.
  const chosen: Array<{ slot: PmaxImageSlot; name: string }> = [];
  for (const slot of Object.keys(PMAX_IMAGE_RULES) as PmaxImageSlot[]) {
    for (const name of build.asset_group.images[slot]) chosen.push({ slot, name });
  }
  const live = new Map((await readChosenAssets(customer, [...new Set(chosen.map((c) => c.name))])).map((a) => [a.resource_name, a]));
  for (const { slot, name } of chosen) {
    const asset = live.get(name);
    if (!asset || !imageFits(slot, asset.width, asset.height)) {
      return { ok: false, code: 'pmax_assets_changed', message: 'A chosen image is gone or no longer fits its slot.' };
    }
  }

  // Audiences: customer lists must be open, custom audiences enabled.
  if (build.signals.user_lists.length > 0) {
    const list = build.signals.user_lists.map((n) => `'${escapeGaql(n)}'`).join(', ');
    const rows = await customer.query(`SELECT user_list.resource_name FROM user_list WHERE user_list.resource_name IN (${list}) AND user_list.membership_status = 'OPEN'`);
    if (rows.length !== build.signals.user_lists.length) {
      return { ok: false, code: 'pmax_assets_changed', message: 'A chosen customer list is closed or gone.' };
    }
  }
  if (build.signals.custom_audiences.length > 0) {
    const list = build.signals.custom_audiences.map((n) => `'${escapeGaql(n)}'`).join(', ');
    const rows = await customer.query(`SELECT custom_audience.resource_name FROM custom_audience WHERE custom_audience.resource_name IN (${list}) AND custom_audience.status = 'ENABLED'`);
    if (rows.length !== build.signals.custom_audiences.length) {
      return { ok: false, code: 'pmax_assets_changed', message: 'A chosen custom audience is disabled or gone.' };
    }
  }

  const reusableVideos: Record<string, string> = {};
  if (build.asset_group.videos.length > 0) {
    try {
      const rows = await customer.query("SELECT asset.resource_name, asset.youtube_video_asset.youtube_video_id FROM asset WHERE asset.type = 'YOUTUBE_VIDEO' LIMIT 1000");
      for (const row of rows) {
        const id = get(row, 'asset.youtube_video_asset.youtube_video_id');
        const name = get(row, 'asset.resource_name');
        if (typeof id === 'string' && typeof name === 'string') reusableVideos[id] = name;
      }
    } catch {
      // Without the list the videos are created again; Google returns the existing asset for the same video.
    }
  }

  return { ok: true, merchantId, feedLabel, reusableVideos };
}
