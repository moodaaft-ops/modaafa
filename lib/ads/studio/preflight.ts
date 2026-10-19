import type { OptimizerAction } from '../../ai/optimizer-agent';
import type { MeasurementDescriptor } from '../../ai/execution-preflight';
import { readOneRsa, type GaqlReader, type RsaTextAsset } from '../assets-reader';
import { esc, list, str, enumOf } from '../rows';
import {
  buildGrounding,
  extractNumbers,
  normalizeText,
  pinsStayTheSame,
  sameMeaning,
  validateAssetText,
  validateRsaStructure,
  type RsaAssetText,
} from '../validators';
import { hostOf } from './validate';
import {
  MAX_CALLOUTS_PER_CAMPAIGN,
  MAX_ENABLED_RSA_FOR_TEST,
  MAX_ENABLED_RSA_PER_AD_GROUP,
  MAX_SITELINKS_PER_CAMPAIGN,
  type AdsStudioOperation,
} from './types';

/**
 * Pre-execution reads for the ad-assets actions. Everything the live mutate
 * needs is read from the account HERE and stored in `params.resolved`; the
 * executor sends exactly that. A stored payload never carries `resolved`
 * (validateAdsStudioPayload builds params from a whitelist).
 */

export class AdsStudioPreflightError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'AdsStudioPreflightError';
  }
}

const refuse = (code: string, message: string): never => {
  throw new AdsStudioPreflightError(code, message);
};

export type StudioPrepared = {
  action: OptimizerAction;
  rollbackPayload: Record<string, unknown>;
  measurement: MeasurementDescriptor | null;
};

export type StudioPreflightDeps = {
  readSevenDayMetrics(
    customer: any,
    fromClause: string,
    whereField: string,
    resourceName: string
  ): Promise<{ cost: number; clicks: number; conversions: number; conversion_value: number } | null>;
};

function withResolved(action: OptimizerAction, resolved: Record<string, unknown>): OptimizerAction {
  return { ...action, params: { ...action.params, resolved } };
}

function customerIdOf(resource: string): string {
  const m = /^customers\/(\d+)\//.exec(resource);
  if (!m) return refuse('resource_invalid', 'Resource name does not carry a customer id');
  return m[1];
}

async function measurementFor(
  deps: StudioPreflightDeps,
  customer: any,
  adGroup: string | null,
  capturedAt: string
): Promise<MeasurementDescriptor | null> {
  if (!adGroup) return null;
  const before = await deps.readSevenDayMetrics(customer, 'ad_group', 'ad_group.resource_name', adGroup);
  return { level: 'ad_group', resource: adGroup, window_days: 7, before, captured_at: capturedAt };
}

// ---------------------------------------------------------------------------
// replace_rsa_assets
// ---------------------------------------------------------------------------

function toPlain(list: readonly RsaTextAsset[]): RsaAssetText[] {
  return list.map((a) => ({ text: a.text, pinned_field: a.pinned_field }));
}

async function enabledRsaCount(customer: GaqlReader, adGroup: string): Promise<number> {
  const rows = await customer.query(`
    SELECT ad_group_ad.resource_name
    FROM ad_group_ad
    WHERE ad_group_ad.ad_group = '${esc(adGroup)}'
      AND ad_group_ad.ad.type = 'RESPONSIVE_SEARCH_AD'
      AND ad_group_ad.status = 'ENABLED'
  `);
  return rows.length;
}

async function prepareReplaceRsa(action: OptimizerAction, customer: any, deps: StudioPreflightDeps): Promise<StudioPrepared> {
  const capturedAt = new Date().toISOString();
  const params = action.params as Record<string, any>;
  const resource = String(params.ad_group_ad_resource);
  const mode: 'swap' | 'test_variant' = params.mode === 'test_variant' ? 'test_variant' : 'swap';
  const language = params.language === 'en' ? 'en' : 'ar';

  const rsa = await readOneRsa(customer, resource);
  if (!rsa) return refuse('ad_not_found', 'The responsive search ad could not be read');
  if (rsa.status !== 'ENABLED') return refuse('ad_not_enabled', 'Only an enabled ad is replaced');
  if (rsa.final_urls.length === 0) return refuse('no_final_url', 'The ad has no final url to copy');

  // The swap is built from the LIVE texts: if the ad changed since the card was made, stop.
  const headlines: RsaTextAsset[] = rsa.headlines.map((h) => ({ ...h }));
  const descriptions: RsaTextAsset[] = rsa.descriptions.map((d) => ({ ...d }));
  const replaced = new Set<string>();
  for (const r of params.replacements as Array<{ field: 'HEADLINE' | 'DESCRIPTION'; old_text: string; new_text: string }>) {
    const pool = r.field === 'HEADLINE' ? headlines : descriptions;
    const index = pool.findIndex((a) => a.text === r.old_text);
    if (index < 0) return refuse('ad_changed', 'A text to replace is no longer in the ad');
    if (pool[index].pinned_field) return refuse('pinned_asset', 'A pinned text is never swapped');
    if (replaced.has(`${r.field}|${r.old_text}`)) return refuse('ad_changed', 'The same text is replaced twice');
    replaced.add(`${r.field}|${r.old_text}`);
    pool[index] = { ...pool[index], text: r.new_text, label: 'PENDING', approval: '', review: '', policy_topics: [] };
  }

  // Numbers in the new copy must exist in the stored sources or in the live ad.
  const allowed = buildGrounding([
    ...(((params.grounding_terms as string[]) ?? []) as string[]),
    ...rsa.headlines.map((h) => h.text),
    ...rsa.descriptions.map((d) => d.text),
  ]);
  for (const r of params.replacements as Array<{ field: 'HEADLINE' | 'DESCRIPTION'; new_text: string }>) {
    for (const n of extractNumbers(r.new_text)) {
      if (!allowed.numbers.has(n)) return refuse('invented_number', 'A number in the new copy is not in the sources');
    }
    const checked = validateAssetText(r.new_text, r.field === 'HEADLINE' ? 'headline' : 'description', {
      language,
      grounding: allowed,
      keepExisting: true,
    });
    if (!checked.ok) return refuse(`text_${checked.code}`, 'New copy failed the text rules');
  }

  const plainH = toPlain(headlines);
  const plainD = toPlain(descriptions);
  const structure = validateRsaStructure(plainH, plainD);
  if (!structure.ok) return refuse(structure.code, 'The new ad does not satisfy the responsive search ad rules');
  if (!pinsStayTheSame(toPlain(rsa.headlines), plainH) || !pinsStayTheSame(toPlain(rsa.descriptions), plainD)) {
    return refuse('pins_changed', 'A replacement would change the pins');
  }
  // The new copy must not restate a text that stays.
  for (const r of params.replacements as Array<{ field: 'HEADLINE' | 'DESCRIPTION'; old_text: string; new_text: string }>) {
    const stays = (r.field === 'HEADLINE' ? headlines : descriptions).filter((a) => a.text !== r.new_text);
    if (stays.some((a) => sameMeaning(a.text, r.new_text))) return refuse('duplicate_meaning', 'New copy repeats a text that stays');
  }

  const enabled = await enabledRsaCount(customer, rsa.ad_group);
  const enabledAfter = mode === 'swap' ? enabled : enabled + 1;
  if (mode === 'test_variant' && enabledAfter > MAX_ENABLED_RSA_FOR_TEST) {
    return refuse('too_many_ads_for_test', 'A test keeps two ads in the ad group');
  }
  if (enabledAfter > MAX_ENABLED_RSA_PER_AD_GROUP) return refuse('too_many_ads', 'The ad group is at the responsive ad limit');

  const swap = mode === 'swap';
  const newAd = {
    ad_group: rsa.ad_group,
    final_urls: rsa.final_urls,
    final_mobile_urls: rsa.final_mobile_urls,
    tracking_url_template: rsa.tracking_url_template || null,
    final_url_suffix: rsa.final_url_suffix || null,
    path1: rsa.path1 || null,
    path2: rsa.path2 || null,
    headlines: plainH.map((h) => ({ text: h.text, pinned_field: h.pinned_field ?? null })),
    descriptions: plainD.map((d) => ({ text: d.text, pinned_field: d.pinned_field ?? null })),
  };
  const resolved = {
    old_ad: resource,
    ad_group: rsa.ad_group,
    campaign: rsa.campaign,
    mode,
    pause_old: swap,
    new_ad: newAd,
    impressions_before: rsa.impressions_30d,
  };
  return {
    action: withResolved(action, resolved),
    rollbackPayload: {
      reversible: true,
      action_type: 'ext_ads_replace_rsa',
      ad_group_resource: rsa.ad_group,
      // The old ad is only paused, never removed; rollback pauses the new one and turns the old one back on.
      reenable_ads: swap ? [resource] : [],
      pause_ads: [],
      // Operation order is [pause old], create new: the created ad is the last result.
      created_ad_indexes: [swap ? 1 : 0],
      touched_resources: [rsa.ad_group, resource],
    },
    measurement: await measurementFor(deps, customer, rsa.ad_group, capturedAt),
  };
}

// ---------------------------------------------------------------------------
// Campaign level assets
// ---------------------------------------------------------------------------

type ExistingAsset = {
  link: string;
  asset: string;
  text: string;
  url: string;
  header: string;
  values: string[];
  phone: string;
};

const FIELD_FOR: Record<string, 'SITELINK' | 'CALLOUT' | 'STRUCTURED_SNIPPET' | 'CALL'> = {
  add_sitelinks: 'SITELINK',
  add_callouts: 'CALLOUT',
  add_structured_snippet: 'STRUCTURED_SNIPPET',
  add_call_asset: 'CALL',
};

export async function readCampaignAssets(
  customer: GaqlReader,
  campaign: string,
  fieldType: 'SITELINK' | 'CALLOUT' | 'STRUCTURED_SNIPPET' | 'CALL'
): Promise<ExistingAsset[]> {
  const rows = await customer.query(`
    SELECT campaign_asset.resource_name, campaign_asset.field_type, asset.resource_name,
      asset.final_urls, asset.sitelink_asset.link_text, asset.callout_asset.callout_text,
      asset.structured_snippet_asset.header, asset.structured_snippet_asset.values,
      asset.call_asset.phone_number
    FROM campaign_asset
    WHERE campaign_asset.campaign = '${esc(campaign)}'
      AND campaign_asset.field_type = '${fieldType}'
      AND campaign_asset.status != 'REMOVED'
    LIMIT 200
  `);
  return rows.map((row) => ({
    link: str(row, 'campaign_asset.resource_name'),
    asset: str(row, 'asset.resource_name'),
    text: str(row, 'asset.sitelink_asset.link_text') || str(row, 'asset.callout_asset.callout_text'),
    url: String(list(row, 'asset.final_urls')[0] ?? ''),
    header: str(row, 'asset.structured_snippet_asset.header'),
    values: list(row, 'asset.structured_snippet_asset.values').filter((v): v is string => typeof v === 'string'),
    phone: str(row, 'asset.call_asset.phone_number'),
  }));
}

async function campaignLandingHosts(customer: GaqlReader, campaign: string): Promise<Set<string>> {
  const rows = await customer.query(`
    SELECT ad_group_ad.ad.final_urls
    FROM ad_group_ad
    WHERE campaign.resource_name = '${esc(campaign)}' AND ad_group_ad.status != 'REMOVED'
    LIMIT 200
  `);
  const hosts = new Set<string>();
  for (const row of rows) {
    for (const url of list(row, 'ad_group_ad.ad.final_urls')) {
      const host = typeof url === 'string' ? hostOf(url) : null;
      if (host) hosts.add(host);
    }
  }
  return hosts;
}

function sameSite(host: string, landing: ReadonlySet<string>): boolean {
  for (const l of landing) {
    if (host === l || host.endsWith(`.${l}`) || l.endsWith(`.${host}`)) return true;
  }
  return false;
}

async function readCampaignOk(customer: GaqlReader, campaign: string): Promise<void> {
  const rows = await customer.query(`
    SELECT campaign.resource_name, campaign.status, campaign.advertising_channel_type
    FROM campaign
    WHERE campaign.resource_name = '${esc(campaign)}'
    LIMIT 1
  `);
  const row = rows[0];
  if (!row) return refuse('campaign_not_found', 'Unable to read the campaign before execution');
  if (enumOf(row, 'campaign.status') === 'REMOVED') refuse('campaign_removed', 'Campaign is removed');
  if (enumOf(row, 'campaign.advertising_channel_type') !== 'SEARCH') {
    refuse('not_search_campaign', 'These assets are added to Search campaigns');
  }
}

async function prepareCampaignAssets(
  action: OptimizerAction,
  customer: any,
  deps: StudioPreflightDeps
): Promise<StudioPrepared> {
  const capturedAt = new Date().toISOString();
  const params = action.params as Record<string, any>;
  const campaign = String(params.campaign_resource);
  const cid = customerIdOf(campaign);
  const fieldType = FIELD_FOR[action.type];
  await readCampaignOk(customer, campaign);
  const existing = await readCampaignAssets(customer, campaign, fieldType);

  type NewAsset = { temp: string; spec: Record<string, unknown> };
  let assets: NewAsset[] = [];
  const temp = (i: number) => `customers/${cid}/assets/-${i + 1}`;

  if (action.type === 'add_sitelinks') {
    const landing = await campaignLandingHosts(customer, campaign);
    if (landing.size === 0) return refuse('landing_host_unknown', 'Cannot tell which site the campaign sends traffic to');
    const items = params.sitelinks as Array<{ final_url: string; link_text: string; description1: string; description2: string }>;
    if (existing.length + items.length > MAX_SITELINKS_PER_CAMPAIGN) {
      return refuse('too_many_sitelinks', 'The campaign would have more sitelinks than the limit');
    }
    for (const item of items) {
      const host = hostOf(item.final_url);
      if (!host || !sameSite(host, landing)) return refuse('sitelink_host_mismatch', 'A sitelink points outside the campaign site');
      if (existing.some((e) => normalizeText(e.text) === normalizeText(item.link_text) || e.url === item.final_url)) {
        return refuse('sitelink_exists', 'The campaign already has this sitelink');
      }
    }
    assets = items.map((item, i) => ({
      temp: temp(i),
      spec: {
        final_urls: [item.final_url],
        sitelink_asset: { link_text: item.link_text, description1: item.description1, description2: item.description2 },
      },
    }));
  } else if (action.type === 'add_callouts') {
    const items = params.callouts as string[];
    if (existing.length + items.length > MAX_CALLOUTS_PER_CAMPAIGN) return refuse('too_many_callouts', 'Too many callouts');
    for (const text of items) {
      if (existing.some((e) => sameMeaning(e.text, text))) return refuse('callout_exists', 'The campaign already has this callout');
    }
    assets = items.map((text, i) => ({ temp: temp(i), spec: { callout_asset: { callout_text: text } } }));
  } else if (action.type === 'add_structured_snippet') {
    if (existing.some((e) => e.header === params.header)) return refuse('snippet_header_exists', 'This snippet header already exists');
    assets = [{ temp: temp(0), spec: { structured_snippet_asset: { header: params.header, values: params.values } } }];
  } else {
    if (existing.length > 0) return refuse('call_asset_exists', 'The campaign already has a call asset');
    assets = [
      {
        temp: temp(0),
        spec: { call_asset: { country_code: params.country_code ?? 'SA', phone_number: params.phone_number } },
      },
    ];
  }

  // Operation order is [asset create, campaign_asset create] per asset: a link is the odd result.
  const linkIndexes = assets.map((_, i) => i * 2 + 1);
  const resolved = { campaign, field_type: fieldType, assets };
  return {
    action: withResolved(action, resolved),
    rollbackPayload: {
      reversible: true,
      action_type: 'ext_ads_remove_campaign_assets',
      campaign_resource: campaign,
      // The assets themselves cannot be removed through the API; unlinking them is the undo.
      remove_campaign_assets: [],
      created_link_indexes: linkIndexes,
      touched_resources: [campaign],
    },
    measurement: null,
  };
}

export async function prepareAdsStudioAction(
  action: OptimizerAction,
  customer: any,
  deps: StudioPreflightDeps
): Promise<StudioPrepared> {
  const operation = action.type as AdsStudioOperation;
  if (operation === 'replace_rsa_assets') return prepareReplaceRsa(action, customer, deps);
  return prepareCampaignAssets(action, customer, deps);
}
