import { EU_POLITICAL_DECLARATION } from '../launch/operations';
import type { MutateOperation } from '../growth/types';
import { ARABIC_LANGUAGE_CONSTANT, ENGLISH_LANGUAGE_CONSTANT, type DemandGenPlan } from './types';

/**
 * One GoogleAdsService:mutate batch that creates the whole Demand Gen campaign,
 * PAUSED: budget, campaign, ad group, location and language, an optional
 * Audience (the plan's user lists), a YouTube video asset when a video id was
 * given, and the ads. Every created resource gets a temporary (negative)
 * resource name; Google applies the batch atomically.
 *
 * Field names follow the Google Ads API v22 guides «Create a Demand Gen
 * campaign» and «Audience targeting» (developers.google.com/google-ads/api/docs/demand-gen).
 * validateOnly is the check on anything the guides do not spell out (see the report).
 */

export type DemandGenOperationContext = {
  customerId: string;
  campaignName: string;
  budgetName: string;
  audienceName: string;
  /** An existing YOUTUBE_VIDEO asset for the plan's video id, to link instead of creating another. */
  existingVideoAsset?: string | null;
};

export type DemandGenRole =
  | 'budget'
  | 'campaign'
  | 'ad_group'
  | 'location'
  | 'language'
  | 'audience'
  | 'audience_criterion'
  | 'asset'
  | 'ad';

export type BuiltDemandGen = {
  operations: MutateOperation[];
  roles: DemandGenRole[];
  temp: { budget: string; campaign: string; adGroup: string; audience: string | null };
  expected: { ads: number; locations: number; languages: number; audience_criteria: number };
};

const textAssets = (lines: string[]) => lines.map((text) => ({ text }));
const imageLinks = (assets: string[]) => assets.map((asset) => ({ asset }));

export function buildDemandGenOperations(plan: DemandGenPlan, ctx: DemandGenOperationContext): BuiltDemandGen {
  if (!plan.executable) throw new Error('Demand Gen plan has blockers and cannot be built.');
  if (plan.channels.display !== false) throw new Error('Display must stay closed in a Demand Gen launch.');
  const root = `customers/${ctx.customerId.replace(/\D/g, '')}`;
  let nextId = 0;
  const temp = (collection: string) => `${root}/${collection}/${--nextId}`;

  const operations: MutateOperation[] = [];
  const roles: DemandGenRole[] = [];
  const push = (role: DemandGenRole, wrapper: string, create: Record<string, unknown>) => {
    operations.push({ [wrapper]: { create } });
    roles.push(role);
  };
  const expected: BuiltDemandGen['expected'] = { ads: 0, locations: 0, languages: 0, audience_criteria: 0 };

  const budget = temp('campaignBudgets');
  const campaign = temp('campaigns');
  const adGroup = temp('adGroups');

  push('budget', 'campaign_budget_operation', {
    resource_name: budget,
    name: ctx.budgetName,
    amount_micros: plan.budget.daily_micros,
    delivery_method: 'STANDARD',
    // Demand Gen budgets cannot be shared.
    explicitly_shared: false,
  });

  const bidding: Record<string, unknown> =
    plan.bidding.strategy === 'TARGET_CPA'
      ? { target_cpa: { target_cpa_micros: plan.bidding.target_cpa_micros } }
      : plan.bidding.strategy === 'MAXIMIZE_CONVERSIONS'
        ? { maximize_conversions: {} }
        : { target_spend: { cpc_bid_ceiling_micros: plan.bidding.cpc_ceiling_micros } };
  push('campaign', 'campaign_operation', {
    resource_name: campaign,
    name: ctx.campaignName,
    status: 'PAUSED',
    advertising_channel_type: 'DEMAND_GEN',
    campaign_budget: budget,
    contains_eu_political_advertising: EU_POLITICAL_DECLARATION,
    ...bidding,
    geo_target_type_setting: { positive_geo_target_type: 'PRESENCE' },
  });

  push('ad_group', 'ad_group_operation', {
    resource_name: adGroup,
    name: plan.ad_group_name,
    campaign,
    status: 'ENABLED',
    // Immutable after creation; required to target an Audience resource.
    audience_setting: { use_audience_grouped: true },
    demand_gen_ad_group_settings: {
      channel_controls: {
        selected_channels: {
          youtube_in_feed: plan.channels.youtube_in_feed,
          youtube_in_stream: plan.channels.youtube_in_stream,
          youtube_shorts: plan.channels.youtube_shorts,
          discover: plan.channels.discover,
          gmail: plan.channels.gmail,
          display: false,
        },
      },
    },
  });

  // Location and language live on the ad group (the guide lists them there), never on both levels.
  const geoConstants = plan.geo.regions.length > 0 ? plan.geo.regions.map((r) => r.geo_target_constant) : [plan.geo.country_constant];
  for (const constant of Array.from(new Set(geoConstants))) {
    push('location', 'ad_group_criterion_operation', { ad_group: adGroup, location: { geo_target_constant: constant } });
    expected.locations += 1;
  }
  push('language', 'ad_group_criterion_operation', {
    ad_group: adGroup,
    language: { language_constant: plan.language === 'en' ? ENGLISH_LANGUAGE_CONSTANT : ARABIC_LANGUAGE_CONSTANT },
  });
  expected.languages += 1;

  let audience: string | null = null;
  if (plan.audience.user_lists.length > 0 || plan.audience.exclude_user_lists.length > 0) {
    audience = temp('audiences');
    push('audience', 'audience_operation', {
      resource_name: audience,
      name: ctx.audienceName,
      ...(plan.audience.user_lists.length > 0
        ? {
            dimensions: [
              { audience_segments: { segments: plan.audience.user_lists.map((userList) => ({ user_list: { user_list: userList } })) } },
            ],
          }
        : {}),
      ...(plan.audience.exclude_user_lists.length > 0
        ? { exclusion_dimension: { exclusions: plan.audience.exclude_user_lists.map((userList) => ({ user_list: { user_list: userList } })) } }
        : {}),
    });
    push('audience_criterion', 'ad_group_criterion_operation', { ad_group: adGroup, audience: { audience } });
    expected.audience_criteria += 1;
  }

  const hasStills = plan.images.marketing.length + plan.images.square.length + plan.images.portrait.length > 0;
  if (hasStills) {
    push('ad', 'ad_group_ad_operation', {
      ad_group: adGroup,
      status: 'ENABLED',
      ad: {
        final_urls: [plan.final_url],
        demand_gen_multi_asset_ad: {
          ...(plan.images.marketing.length ? { marketing_images: imageLinks(plan.images.marketing) } : {}),
          ...(plan.images.square.length ? { square_marketing_images: imageLinks(plan.images.square) } : {}),
          ...(plan.images.portrait.length ? { portrait_marketing_images: imageLinks(plan.images.portrait) } : {}),
          logo_images: imageLinks(plan.images.logo),
          headlines: textAssets(plan.copy.headlines),
          descriptions: textAssets(plan.copy.descriptions),
          business_name: plan.business_name,
        },
      },
    });
    expected.ads += 1;
  }

  if (plan.video) {
    const videoAsset =
      ctx.existingVideoAsset ??
      (() => {
        const name = temp('assets');
        push('asset', 'asset_operation', {
          resource_name: name,
          youtube_video_asset: { youtube_video_id: plan.video!.youtube_video_id },
        });
        return name;
      })();
    push('ad', 'ad_group_ad_operation', {
      ad_group: adGroup,
      status: 'ENABLED',
      ad: {
        final_urls: [plan.final_url],
        demand_gen_video_responsive_ad: {
          videos: [{ asset: videoAsset }],
          logo_images: imageLinks(plan.images.logo),
          headlines: textAssets(plan.copy.headlines),
          long_headlines: textAssets(plan.copy.long_headlines),
          descriptions: textAssets(plan.copy.descriptions),
          business_name: { text: plan.business_name },
        },
      },
    });
    expected.ads += 1;
  }

  return { operations, roles, temp: { budget, campaign, adGroup, audience }, expected };
}
