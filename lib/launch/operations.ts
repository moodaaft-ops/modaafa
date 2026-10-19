import type { LaunchPlan } from './types';

/**
 * One GoogleAdsService:mutate batch that creates the whole campaign.
 *
 * Every created resource gets a TEMPORARY resource name (negative id) so later
 * operations in the same batch can reference it; Google applies the batch
 * atomically (no partial failure), so the account ends with everything or
 * nothing. The campaign is created PAUSED and nothing here can enable it.
 *
 * API version: the REST client pins `v22` by default (GOOGLE_ADS_API_VERSION).
 * Field names were checked against the v17 protos in node_modules
 * (google-ads-node 14) and the v22 docs for the fields added since then
 * (Campaign.contains_eu_political_advertising, ShoppingSetting).
 */

export type MutateOperation = Record<string, { create?: Record<string, unknown>; remove?: string }>;

export type OperationContext = {
  /** Digits only. */
  customerId: string;
  /** Unique among the account's live campaigns (the executor checks and suffixes). */
  campaignName: string;
  budgetName: string;
  /** Merchant Center id, read from the account. Required for SHOPPING. */
  merchantId?: number | null;
  /** Resource name of the account's LOCATION_SYNC asset set, when one exists. */
  locationSyncAssetSet?: string | null;
  /** A NEGATIVE_KEYWORDS shared set with the starter list's name, to link instead of creating. */
  existingSharedSet?: string | null;
  /** Assets the account already has, keyed so a re-launch links them instead of creating duplicates. */
  reusableAssets?: {
    sitelinks?: Record<string, string>;
    callouts?: Record<string, string>;
    snippets?: Record<string, string>;
    calls?: Record<string, string>;
  };
};

export type OperationRole =
  | 'budget'
  | 'campaign'
  | 'location'
  | 'campaign_negative'
  | 'shared_set'
  | 'shared_negative'
  | 'campaign_shared_set'
  | 'ad_group'
  | 'keyword'
  | 'ad'
  | 'listing_group'
  | 'asset'
  | 'campaign_asset'
  | 'campaign_asset_set';

export type BuiltOperations = {
  operations: MutateOperation[];
  /** Same length as `operations`: what each operation creates. */
  roles: OperationRole[];
  /** Temporary resource names, for tests and the readback. */
  temp: { budget: string; campaign: string; sharedSet: string | null; adGroups: string[] };
  expected: {
    ad_groups: number;
    keywords: number;
    ads: number;
    campaign_negatives: number;
    shared_negatives: number;
    assets_created: number;
    asset_links: number;
    locations: number;
  };
};

export const EU_POLITICAL_DECLARATION = 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING';

/** Keys under which an existing asset is reused instead of creating a duplicate. */
export const reusableKeys = {
  sitelink: (text: string, url: string, d1?: string | null, d2?: string | null) =>
    `${text.toLowerCase()}|${url}|${(d1 ?? '').toLowerCase()}|${(d2 ?? '').toLowerCase()}`,
  callout: (text: string) => text.toLowerCase(),
  snippet: (header: string, values: string[]) => `${header}|${values.join('|')}`.toLowerCase(),
  call: (phone: string) => phone,
};

export function buildLaunchOperations(plan: LaunchPlan, ctx: OperationContext): BuiltOperations {
  if (plan.settings.status !== 'PAUSED') throw new Error('Launch plans are always created PAUSED.');
  if (!plan.executable) throw new Error('Launch plan has blockers and cannot be built.');
  if (plan.type === 'PMAX') throw new Error('Performance Max launch is not supported yet.');
  if (plan.type === 'SHOPPING' && !ctx.merchantId) throw new Error('Shopping launch needs a Merchant Center id.');
  if (plan.geo.regions.some((r) => !r.geo_target_constant)) throw new Error('Every region needs a geo target constant.');

  const customer = ctx.customerId.replace(/\D/g, '');
  const root = `customers/${customer}`;
  let nextId = 0;
  const temp = (collection: string) => `${root}/${collection}/${--nextId}`;

  const operations: MutateOperation[] = [];
  const roles: OperationRole[] = [];
  const push = (role: OperationRole, wrapper: string, create: Record<string, unknown>) => {
    operations.push({ [wrapper]: { create } });
    roles.push(role);
  };

  const budget = temp('campaignBudgets');
  const campaign = temp('campaigns');
  const expected: BuiltOperations['expected'] = {
    ad_groups: 0, keywords: 0, ads: 0, campaign_negatives: 0, shared_negatives: 0,
    assets_created: 0, asset_links: 0, locations: 0,
  };

  // ---- Budget --------------------------------------------------------------------
  push('budget', 'campaign_budget_operation', {
    resource_name: budget,
    name: ctx.budgetName,
    amount_micros: plan.budget.daily_micros,
    delivery_method: 'STANDARD',
    explicitly_shared: false,
  });

  // ---- Campaign -------------------------------------------------------------------
  const bidding: Record<string, unknown> =
    plan.bidding.strategy === 'MAXIMIZE_CONVERSIONS'
      ? { maximize_conversions: {} }
      : plan.bidding.strategy === 'MANUAL_CPC'
        ? { manual_cpc: {} }
        : {
            target_spend: {
              ...(plan.bidding.cpc_ceiling_micros ? { cpc_bid_ceiling_micros: plan.bidding.cpc_ceiling_micros } : {}),
            },
          };
  push('campaign', 'campaign_operation', {
    resource_name: campaign,
    name: ctx.campaignName,
    status: 'PAUSED',
    advertising_channel_type: plan.type,
    campaign_budget: budget,
    contains_eu_political_advertising: EU_POLITICAL_DECLARATION,
    ...bidding,
    network_settings: {
      target_google_search: true,
      // «Search Partners» is target_search_network. Off at launch (titan 3.6).
      target_search_network: false,
      target_content_network: false,
      target_partner_search_network: false,
    },
    geo_target_type_setting: { positive_geo_target_type: plan.settings.positive_geo_target_type },
    ...(plan.type === 'SHOPPING'
      ? { shopping_setting: { merchant_id: ctx.merchantId, campaign_priority: plan.shopping?.campaign_priority ?? 0 } }
      : {}),
  });

  // ---- Locations --------------------------------------------------------------------
  const geoConstants =
    plan.geo.regions.length > 0 ? plan.geo.regions.map((r) => r.geo_target_constant as string) : [plan.geo.country_constant];
  for (const constant of Array.from(new Set(geoConstants))) {
    push('location', 'campaign_criterion_operation', { campaign, location: { geo_target_constant: constant } });
    expected.locations += 1;
  }

  // ---- Negatives -----------------------------------------------------------------------
  for (const negative of plan.campaign_negatives) {
    push('campaign_negative', 'campaign_criterion_operation', {
      campaign,
      negative: true,
      keyword: { text: negative.text, match_type: negative.match_type },
    });
    expected.campaign_negatives += 1;
  }
  let sharedSet: string | null = null;
  if (plan.shared_negative_list.keywords.length > 0) {
    if (ctx.existingSharedSet) {
      sharedSet = ctx.existingSharedSet;
    } else {
      sharedSet = temp('sharedSets');
      push('shared_set', 'shared_set_operation', {
        resource_name: sharedSet,
        name: plan.shared_negative_list.name,
        type: 'NEGATIVE_KEYWORDS',
      });
      for (const negative of plan.shared_negative_list.keywords) {
        push('shared_negative', 'shared_criterion_operation', {
          shared_set: sharedSet,
          keyword: { text: negative.text, match_type: negative.match_type },
        });
        expected.shared_negatives += 1;
      }
    }
    push('campaign_shared_set', 'campaign_shared_set_operation', { campaign, shared_set: sharedSet });
  }

  // ---- Ad groups ------------------------------------------------------------------------
  const adGroupNames: string[] = [];
  for (const group of plan.ad_groups) {
    const adGroup = temp('adGroups');
    adGroupNames.push(adGroup);
    expected.ad_groups += 1;
    const shopping = plan.type === 'SHOPPING';
    // Only manual CPC reads the ad group bid; with Maximize Clicks the campaign ceiling rules.
    const bid =
      plan.bidding.strategy === 'MANUAL_CPC' || shopping
        ? { cpc_bid_micros: plan.bidding.cpc_ceiling_micros ?? 10_000 }
        : {};
    push('ad_group', 'ad_group_operation', {
      resource_name: adGroup,
      name: group.name,
      campaign,
      status: 'ENABLED',
      type: shopping ? 'SHOPPING_PRODUCT_ADS' : 'SEARCH_STANDARD',
      ...bid,
    });
    if (shopping) {
      push('listing_group', 'ad_group_criterion_operation', {
        ad_group: adGroup,
        status: 'ENABLED',
        listing_group: { type: 'UNIT' },
        cpc_bid_micros: plan.bidding.cpc_ceiling_micros ?? 10_000,
      });
      push('ad', 'ad_group_ad_operation', { ad_group: adGroup, status: 'ENABLED', ad: { shopping_product_ad: {} } });
      expected.ads += 1;
      continue;
    }
    for (const keyword of group.keywords) {
      push('keyword', 'ad_group_criterion_operation', {
        ad_group: adGroup,
        status: 'ENABLED',
        keyword: { text: keyword.text, match_type: keyword.match_type },
      });
      expected.keywords += 1;
    }
    if (group.rsa) {
      push('ad', 'ad_group_ad_operation', {
        ad_group: adGroup,
        status: 'ENABLED',
        ad: {
          final_urls: [group.final_url],
          responsive_search_ad: {
            headlines: group.rsa.headlines.map((text) => ({ text })),
            descriptions: group.rsa.descriptions.map((text) => ({ text })),
            ...(group.rsa.path1 ? { path1: group.rsa.path1 } : {}),
            ...(group.rsa.path2 ? { path2: group.rsa.path2 } : {}),
          },
        },
      });
      expected.ads += 1;
    }
  }

  // ---- Assets (Search only) --------------------------------------------------------------------
  const linkAsset = (assetName: string, fieldType: string) => {
    push('campaign_asset', 'campaign_asset_operation', { campaign, asset: assetName, field_type: fieldType });
    expected.asset_links += 1;
  };
  const createAsset = (body: Record<string, unknown>) => {
    const assetName = temp('assets');
    push('asset', 'asset_operation', { resource_name: assetName, ...body });
    expected.assets_created += 1;
    return assetName;
  };
  const reuse = ctx.reusableAssets ?? {};

  for (const link of plan.assets.sitelinks) {
    const existing = reuse.sitelinks?.[reusableKeys.sitelink(link.link_text, link.final_url, link.description1, link.description2)];
    const assetName =
      existing ??
      createAsset({
        final_urls: [link.final_url],
        sitelink_asset: {
          link_text: link.link_text,
          ...(link.description1 && link.description2
            ? { description1: link.description1, description2: link.description2 }
            : {}),
        },
      });
    linkAsset(assetName, 'SITELINK');
  }
  for (const text of plan.assets.callouts) {
    const existing = reuse.callouts?.[reusableKeys.callout(text)];
    linkAsset(existing ?? createAsset({ callout_asset: { callout_text: text } }), 'CALLOUT');
  }
  if (plan.assets.structured_snippet) {
    const snippet = plan.assets.structured_snippet;
    const existing = reuse.snippets?.[reusableKeys.snippet(snippet.header, snippet.values)];
    linkAsset(
      existing ?? createAsset({ structured_snippet_asset: { header: snippet.header, values: snippet.values } }),
      'STRUCTURED_SNIPPET'
    );
  }
  if (plan.assets.call_phone) {
    const existing = reuse.calls?.[reusableKeys.call(plan.assets.call_phone)];
    linkAsset(
      existing ??
        createAsset({
          call_asset: {
            country_code: 'SA',
            phone_number: plan.assets.call_phone,
            // Google's call-tracking numbers do not exist in Saudi Arabia (titan 4), so no call conversions from the asset.
            call_conversion_reporting_state: 'DISABLED',
          },
        }),
      'CALL'
    );
  }
  if (plan.assets.use_location_sync && ctx.locationSyncAssetSet) {
    push('campaign_asset_set', 'campaign_asset_set_operation', { campaign, asset_set: ctx.locationSyncAssetSet });
    expected.asset_links += 1;
  }

  return {
    operations,
    roles,
    temp: { budget, campaign, sharedSet: sharedSet && sharedSet.includes('/-') ? sharedSet : null, adGroups: adGroupNames },
    expected,
  };
}
