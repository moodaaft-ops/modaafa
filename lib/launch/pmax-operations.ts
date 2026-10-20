import { ASSET_FIELD, type PmaxImageSlot } from './pmax';
import { EU_POLITICAL_DECLARATION, type BuiltOperations, type MutateOperation, type OperationContext, type OperationRole } from './operations';
import type { LaunchPlan } from './types';

/**
 * The mutate batch for a Performance Max launch: budget, campaign (PAUSED),
 * locations, negatives, the asset group with its text and linked assets, the
 * audience signals and, for retail, the listing group root. One atomic
 * GoogleAdsService:mutate, temporary negative ids for everything created.
 *
 * Field names were checked against the v22 protos (google-ads python 30.0.0):
 * AssetGroup, AssetGroupAsset, AssetGroupSignal (audience, search_theme),
 * AssetGroupListingGroupFilter (UNIT_INCLUDED, listing_source SHOPPING),
 * Audience (scope ASSET_GROUP, dimensions.audience_segments), Campaign
 * .asset_automation_settings (url_expansion_opt_out no longer exists in v22),
 * SharedSetType BRANDS, CampaignCriterion.brand_list, WebpageInfo.
 *
 * NOT verified against a live account: that final URL expansion is controlled
 * by FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION, that campaign-level negative
 * keywords are accepted on Performance Max, and that an asset-group scoped
 * Audience can be created inside the same batch. validateOnly runs before every
 * live call and would refuse any of them.
 */

const IMAGE_SLOTS: PmaxImageSlot[] = ['marketing', 'square', 'portrait', 'logo', 'landscape_logo'];

export type PmaxOperationContext = OperationContext & {
  /** Feed label of the Merchant Center feed (shopping_product.feed_label), for retail. */
  feedLabel?: string | null;
  /** Brands resolved to Google brand ids (BrandSuggestionService). Absent: brand names become phrase negatives. */
  brandEntities?: Array<{ display_name: string; entity_id: string }> | null;
  /** Video assets the account already has, by YouTube id. */
  reusableVideos?: Record<string, string>;
};

export function buildPmaxLaunchOperations(plan: LaunchPlan, ctx: PmaxOperationContext): BuiltOperations {
  const build = plan.pmax?.build;
  if (!build) throw new Error('Performance Max plan has no asset group.');
  const retail = build.retail !== null;
  if (retail && !ctx.merchantId) throw new Error('Retail Performance Max needs a Merchant Center id.');

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

  push('budget', 'campaign_budget_operation', {
    resource_name: budget,
    name: ctx.budgetName,
    amount_micros: plan.budget.daily_micros,
    delivery_method: 'STANDARD',
    explicitly_shared: false,
  });

  push('campaign', 'campaign_operation', {
    resource_name: campaign,
    name: ctx.campaignName,
    status: 'PAUSED',
    advertising_channel_type: 'PERFORMANCE_MAX',
    campaign_budget: budget,
    contains_eu_political_advertising: EU_POLITICAL_DECLARATION,
    brand_guidelines_enabled: true,
    ...(plan.bidding.strategy === 'MAXIMIZE_CONVERSION_VALUE' ? { maximize_conversion_value: {} } : { maximize_conversions: {} }),
    geo_target_type_setting: { positive_geo_target_type: plan.settings.positive_geo_target_type },
    // Off by default: Google does not send traffic to pages we did not choose. v22 has no url_expansion_opt_out;
    // the setting lives in asset_automation_settings.
    ...(build.url_expansion.enabled
      ? {}
      : {
          asset_automation_settings: [
            { asset_automation_type: 'FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION', asset_automation_status: 'OPTED_OUT' },
          ],
        }),
    ...(retail
      ? { shopping_setting: { merchant_id: ctx.merchantId, ...(ctx.feedLabel ? { feed_label: ctx.feedLabel } : {}) } }
      : {}),
  });

  // ---- Locations --------------------------------------------------------------------
  const geoConstants =
    plan.geo.regions.length > 0 ? plan.geo.regions.map((r) => r.geo_target_constant as string) : [plan.geo.country_constant];
  for (const constant of Array.from(new Set(geoConstants))) {
    push('location', 'campaign_criterion_operation', { campaign, location: { geo_target_constant: constant } });
    expected.locations += 1;
  }

  // ---- Negatives and brand exclusions --------------------------------------------------
  for (const negative of plan.campaign_negatives) {
    push('campaign_negative', 'campaign_criterion_operation', {
      campaign,
      negative: true,
      keyword: { text: negative.text, match_type: negative.match_type },
    });
    expected.campaign_negatives += 1;
  }
  const brands = plan.pmax?.brand_exclusions ?? [];
  if (brands.length > 0) {
    if (ctx.brandEntities && ctx.brandEntities.length > 0) {
      // A brand list (shared set of type BRANDS) excluded on the campaign.
      const set = temp('sharedSets');
      push('shared_set', 'shared_set_operation', { resource_name: set, name: `${ctx.campaignName} | ماركات مستبعدة`.slice(0, 120), type: 'BRANDS' });
      for (const brand of ctx.brandEntities) {
        push('shared_negative', 'shared_criterion_operation', { shared_set: set, brand: { entity_id: brand.entity_id } });
        expected.shared_negatives += 1;
      }
      push('campaign_negative', 'campaign_criterion_operation', { campaign, negative: true, brand_list: { shared_set: set } });
      expected.campaign_negatives += 1;
    } else {
      // No brand ids resolved: the names are excluded as phrase negative keywords instead.
      for (const brand of brands) {
        push('campaign_negative', 'campaign_criterion_operation', {
          campaign,
          negative: true,
          keyword: { text: brand, match_type: 'PHRASE' },
        });
        expected.campaign_negatives += 1;
      }
    }
  }
  if (build.url_expansion.enabled) {
    for (const url of build.url_expansion.excluded_urls) {
      push('campaign_negative', 'campaign_criterion_operation', {
        campaign,
        negative: true,
        webpage: { criterion_name: url.slice(0, 120), conditions: [{ operand: 'URL', operator: 'CONTAINS', argument: url }] },
      });
    }
  }

  // ---- Asset group ---------------------------------------------------------------------
  const group = build.asset_group;
  const assetGroup = temp('assetGroups');
  push('asset_group', 'asset_group_operation', {
    resource_name: assetGroup,
    campaign,
    name: group.name,
    final_urls: [group.final_url],
    status: 'ENABLED',
  });

  const link = (assetName: string, fieldType: string) => {
    const brand = ['BUSINESS_NAME', 'LOGO', 'LANDSCAPE_LOGO'].includes(fieldType);
    if (brand) push('campaign_asset', 'campaign_asset_operation', { campaign, asset: assetName, field_type: fieldType });
    else push('asset_group_asset', 'asset_group_asset_operation', { asset_group: assetGroup, asset: assetName, field_type: fieldType });
    expected.asset_links += 1;
  };
  const textAsset = (value: string, fieldType: string) => {
    const assetName = temp('assets');
    push('asset', 'asset_operation', { resource_name: assetName, text_asset: { text: value } });
    expected.assets_created += 1;
    link(assetName, fieldType);
  };
  for (const headline of group.headlines) textAsset(headline, 'HEADLINE');
  for (const headline of group.long_headlines) textAsset(headline, 'LONG_HEADLINE');
  for (const description of group.descriptions) textAsset(description, 'DESCRIPTION');
  textAsset(group.business_name, 'BUSINESS_NAME');

  for (const slot of IMAGE_SLOTS) {
    for (const assetName of group.images[slot]) link(assetName, ASSET_FIELD[slot]);
  }
  for (const id of group.videos) {
    const existing = ctx.reusableVideos?.[id];
    let assetName = existing;
    if (!assetName) {
      assetName = temp('assets');
      push('asset', 'asset_operation', { resource_name: assetName, youtube_video_asset: { youtube_video_id: id } });
      expected.assets_created += 1;
    }
    link(assetName, 'YOUTUBE_VIDEO');
  }

  // ---- Signals ---------------------------------------------------------------------------
  for (const theme of build.signals.search_themes) {
    push('asset_group_signal', 'asset_group_signal_operation', { asset_group: assetGroup, search_theme: { text: theme } });
  }
  const segments = [
    ...build.signals.user_lists.map((name) => ({ user_list: { user_list: name } })),
    ...build.signals.custom_audiences.map((name) => ({ custom_audience: { custom_audience: name } })),
  ];
  if (segments.length > 0) {
    const audience = temp('audiences');
    push('audience', 'audience_operation', {
      resource_name: audience,
      name: `${group.name} | جمهور`.slice(0, 120),
      description: 'إشارة جمهور لحملة الأداء الأقصى',
      scope: 'ASSET_GROUP',
      asset_group: assetGroup,
      dimensions: [{ audience_segments: { segments } }],
    });
    push('asset_group_signal', 'asset_group_signal_operation', { asset_group: assetGroup, audience: { audience } });
  }

  // ---- Retail: every product of the feed, to be subdivided later by an approval action -------
  if (retail) {
    push('asset_group_filter', 'asset_group_listing_group_filter_operation', {
      asset_group: assetGroup,
      type: 'UNIT_INCLUDED',
      listing_source: 'SHOPPING',
    });
  }

  // Google validates each consecutive block of AssetGroupAsset operations as
  // a complete group. Create all assets first, then campaign brand links, then
  // the group and its uninterrupted asset links. Keep roles aligned for undo.
  const rank = (role: OperationRole) => role === 'asset' ? 0 : role === 'campaign_asset' ? 2 : role === 'asset_group' ? 3 : role === 'asset_group_asset' ? 4 : ['audience','asset_group_signal','asset_group_filter'].includes(role) ? 5 : 1;
  const ordered = operations.map((op, i) => ({ op, role: roles[i], i })).sort((a,b) => rank(a.role)-rank(b.role) || a.i-b.i);
  operations.splice(0, operations.length, ...ordered.map((v) => v.op));
  roles.splice(0, roles.length, ...ordered.map((v) => v.role));
  return { operations, roles, temp: { budget, campaign, sharedSet: null, adGroups: [] }, expected };
}
