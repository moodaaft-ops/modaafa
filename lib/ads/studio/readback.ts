import type { OptimizerAction } from '../../ai/optimizer-agent';
import { readAdGroupRsas } from '../assets-reader';
import { normalizeText } from '../validators';
import { readCampaignAssets } from './preflight';

/**
 * Reads the account back after a live mutate and says whether the change is
 * there. Never throws and never undoes anything (same contract as
 * lib/ai/extended-actions/readback.ts, which calls this for the ad-assets
 * operations).
 */

export type StudioReadback = { status: 'verified' | 'mismatch' | 'unavailable'; detail?: string };

const ok = (): StudioReadback => ({ status: 'verified' });
const mismatch = (detail: string): StudioReadback => ({ status: 'mismatch', detail });

export async function readbackAdsStudioAction(action: OptimizerAction, customer: any): Promise<StudioReadback> {
  try {
    const params = action.params as Record<string, any>;
    const resolved = (params.resolved ?? {}) as Record<string, any>;

    if (action.type === 'replace_rsa_assets') {
      const ads = await readAdGroupRsas(customer, String(resolved.ad_group));
      const wanted = new Set<string>(
        [...(resolved.new_ad?.headlines ?? []), ...(resolved.new_ad?.descriptions ?? [])].map((a: any) => normalizeText(String(a.text)))
      );
      const live = ads.find(
        (ad) =>
          ad.status === 'ENABLED' &&
          ad.ad_group_ad !== resolved.old_ad &&
          [...ad.headlines, ...ad.descriptions].length === wanted.size &&
          [...ad.headlines, ...ad.descriptions].every((a) => wanted.has(normalizeText(a.text)))
      );
      if (!live) return mismatch('new ad not found enabled');
      if (resolved.pause_old === true) {
        const old = ads.find((ad) => ad.ad_group_ad === resolved.old_ad);
        if (old && old.status === 'ENABLED') return mismatch('old ad still enabled');
      }
      return ok();
    }

    const fieldType = String(resolved.field_type);
    const live = await readCampaignAssets(customer, String(params.campaign_resource), fieldType as any);
    if (action.type === 'add_sitelinks') {
      const missing = (params.sitelinks as Array<{ link_text: string }>).filter(
        (s) => !live.some((l) => normalizeText(l.text) === normalizeText(s.link_text))
      );
      return missing.length === 0 ? ok() : mismatch(`${missing.length} sitelink(s) missing`);
    }
    if (action.type === 'add_callouts') {
      const missing = (params.callouts as string[]).filter((c) => !live.some((l) => normalizeText(l.text) === normalizeText(c)));
      return missing.length === 0 ? ok() : mismatch(`${missing.length} callout(s) missing`);
    }
    if (action.type === 'add_structured_snippet') {
      return live.some((l) => l.header === params.header) ? ok() : mismatch('snippet not found');
    }
    if (action.type === 'add_call_asset') {
      return live.length > 0 ? ok() : mismatch('call asset not found');
    }
    return { status: 'unavailable', detail: 'no_readback_for_type' };
  } catch (error) {
    return { status: 'unavailable', detail: error instanceof Error ? error.message.slice(0, 200) : 'read_failed' };
  }
}
