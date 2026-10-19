import { toFieldMask } from '../../google-ads/client';
import type { OptimizerAction } from '../../ai/optimizer-agent';
import type { AdsStudioOperation } from './types';

/**
 * Builds the googleAds:mutate operations for the ad-assets actions from the
 * `params.resolved` block that preflight wrote, and the matching rollback.
 * validateOnly and the live call send the SAME operations. Operations are
 * written in snake_case; the REST wrapper camelizes the keys.
 *
 * Rollback never removes an ad: a replaced ad is only paused, and undoing the
 * change pauses the new ad and enables the old one again. Assets cannot be
 * removed through the API, so the undo of an extension is unlinking it from
 * the campaign.
 */

export type StudioOperation = Record<string, Record<string, unknown>>;

function resolvedOf(action: OptimizerAction): Record<string, any> {
  const resolved = (action.params as Record<string, unknown>).resolved;
  if (!resolved || typeof resolved !== 'object') {
    throw new Error('Ad assets action was not prepared: run prepareActionForExecution first');
  }
  return resolved as Record<string, any>;
}

function drop<T extends Record<string, unknown>>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out as T;
}

export function buildAdsStudioOperations(action: OptimizerAction): StudioOperation[] {
  const resolved = resolvedOf(action);

  switch (action.type as AdsStudioOperation) {
    case 'replace_rsa_assets': {
      const ad = resolved.new_ad as Record<string, any>;
      const ops: StudioOperation[] = [];
      // Pause first, then create, in one atomic request: the ad group never holds more enabled ads than the limit.
      if (resolved.pause_old === true) {
        ops.push({
          ad_group_ad_operation: {
            update: { resource_name: resolved.old_ad, status: 'PAUSED' },
            update_mask: toFieldMask(['status']),
          },
        });
      }
      const text = (a: { text: string; pinned_field: string | null }) => drop({ text: a.text, pinned_field: a.pinned_field });
      ops.push({
        ad_group_ad_operation: {
          create: {
            ad_group: ad.ad_group,
            status: 'ENABLED',
            ad: drop({
              final_urls: ad.final_urls,
              final_mobile_urls: ad.final_mobile_urls,
              tracking_url_template: ad.tracking_url_template,
              final_url_suffix: ad.final_url_suffix,
              responsive_search_ad: drop({
                headlines: (ad.headlines as any[]).map(text),
                descriptions: (ad.descriptions as any[]).map(text),
                path1: ad.path1,
                path2: ad.path2,
              }),
            }),
          },
        },
      });
      return ops;
    }

    case 'add_sitelinks':
    case 'add_callouts':
    case 'add_structured_snippet':
    case 'add_call_asset': {
      const campaign = (action.params as Record<string, any>).campaign_resource as string;
      const ops: StudioOperation[] = [];
      for (const asset of resolved.assets as Array<{ temp: string; spec: Record<string, unknown> }>) {
        ops.push({ asset_operation: { create: { resource_name: asset.temp, ...asset.spec } } });
        ops.push({
          campaign_asset_operation: {
            create: { campaign, asset: asset.temp, field_type: resolved.field_type },
          },
        });
      }
      return ops;
    }

    default:
      throw new Error(`No mutate operations for ${action.type}`);
  }
}

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

function resultNames(result: any): string[] {
  const results: any[] = Array.isArray(result?.results) ? result.results : [];
  return results
    .map((entry) => entry?.resourceName ?? entry?.resource_name)
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
}

export function finalizeAdsStudioRollback(payload: Record<string, any>, result: unknown): Record<string, unknown> {
  const names = resultNames(result);
  const touched: string[] = Array.isArray(payload.touched_resources) ? [...payload.touched_resources] : [];
  const pick = (indexes: unknown): string[] | null => {
    if (!Array.isArray(indexes)) return [];
    const out: string[] = [];
    for (const index of indexes) {
      const name = names[Number(index)];
      if (typeof name !== 'string' || !name) return null;
      out.push(name);
    }
    return out;
  };
  const unavailable = () => ({ ...payload, reversible: false, note: 'created_resources_unavailable' });

  if (payload.action_type === 'ext_ads_replace_rsa') {
    const created = pick(payload.created_ad_indexes);
    if (!created) return unavailable();
    return { ...payload, pause_ads: created, touched_resources: [...new Set([...touched, ...created])] };
  }
  if (payload.action_type === 'ext_ads_remove_campaign_assets') {
    const links = pick(payload.created_link_indexes);
    if (!links) return unavailable();
    return { ...payload, remove_campaign_assets: links, touched_resources: [...new Set([...touched, ...links])] };
  }
  return payload;
}

export function buildAdsStudioRollbackOperations(rollback: Record<string, any>): StudioOperation[] {
  const touched = new Set<string>(Array.isArray(rollback.touched_resources) ? rollback.touched_resources : []);
  const guard = (name: unknown): string => {
    if (typeof name !== 'string' || !name || !touched.has(name)) {
      throw new Error('Rollback names a resource that is not part of the original change');
    }
    return name;
  };
  const names = (value: unknown): string[] => (Array.isArray(value) ? value.map(guard) : []);
  const status = (resource: string, value: 'PAUSED' | 'ENABLED'): StudioOperation => ({
    ad_group_ad_operation: { update: { resource_name: resource, status: value }, update_mask: toFieldMask(['status']) },
  });

  switch (rollback.action_type) {
    case 'ext_ads_replace_rsa': {
      const ops: StudioOperation[] = [];
      for (const name of names(rollback.pause_ads)) ops.push(status(name, 'PAUSED'));
      for (const name of names(rollback.reenable_ads)) ops.push(status(name, 'ENABLED'));
      return ops;
    }
    case 'ext_ads_remove_campaign_assets':
      return names(rollback.remove_campaign_assets).map((name) => ({ campaign_asset_operation: { remove: name } }));
    default:
      throw new Error('This action does not have a supported rollback operation');
  }
}
