import { enumOf, esc, list, num, pick, str } from './rows';
import { isPinField, type PinField } from './validators';

/**
 * Reads what each ad is made of and how Google rates every text:
 *
 *   ad_group_ad_asset_view.performance_label  LEARNING | PENDING | LOW | GOOD | BEST
 *   ad_group_ad_asset_view.policy_summary     approval and review status per text
 *   ad_group_ad.ad_strength                   POOR | AVERAGE | GOOD | EXCELLENT
 *
 * Field names checked against the v22 protos (google-ads python wheel 29 to 31),
 * not against a live account. In v22 `asset_group_asset` has NO performance_label
 * (only the ad view has it), so Performance Max asset groups are read for
 * status, policy and ad strength only; see readAssetGroups.
 *
 * Pure normalisers are exported for tests; the read functions take any object
 * with `query(gaql)`.
 */

export type GaqlReader = { query: (gaql: string) => Promise<any[]> };

export const ASSET_LABELS = ['BEST', 'GOOD', 'LOW', 'LEARNING', 'PENDING', 'UNKNOWN'] as const;
export type AssetLabel = (typeof ASSET_LABELS)[number];

export type RsaTextAsset = {
  text: string;
  field: 'HEADLINE' | 'DESCRIPTION';
  label: AssetLabel;
  pinned_field: PinField | null;
  /** APPROVED, APPROVED_LIMITED, DISAPPROVED, AREA_OF_INTEREST_ONLY or '' when unknown */
  approval: string;
  review: string;
  policy_topics: string[];
};

export type RsaSummary = {
  ad_group_ad: string;
  ad_id: string;
  campaign: string;
  campaign_name: string;
  ad_group: string;
  ad_group_name: string;
  status: string;
  ad_strength: string;
  approval: string;
  review: string;
  final_urls: string[];
  final_mobile_urls: string[];
  tracking_url_template: string;
  final_url_suffix: string;
  path1: string;
  path2: string;
  impressions_30d: number;
  clicks_30d: number;
  conversions_30d: number;
  cost_30d: number;
  headlines: RsaTextAsset[];
  descriptions: RsaTextAsset[];
  /** false when the per-asset view could not be read and the inline labels were used */
  labels_from_view: boolean;
};

const RSA_QUERY = `
  SELECT campaign.resource_name, campaign.name, ad_group.resource_name, ad_group.name,
    ad_group_ad.resource_name, ad_group_ad.status, ad_group_ad.ad_strength,
    ad_group_ad.policy_summary.approval_status, ad_group_ad.policy_summary.review_status,
    ad_group_ad.ad.id, ad_group_ad.ad.final_urls, ad_group_ad.ad.final_mobile_urls,
    ad_group_ad.ad.tracking_url_template, ad_group_ad.ad.final_url_suffix,
    ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions,
    ad_group_ad.ad.responsive_search_ad.path1, ad_group_ad.ad.responsive_search_ad.path2,
    metrics.impressions, metrics.clicks, metrics.conversions, metrics.cost_micros
  FROM ad_group_ad
  WHERE ad_group_ad.ad.type = 'RESPONSIVE_SEARCH_AD'
    AND ad_group_ad.status != 'REMOVED'
    AND campaign.status != 'REMOVED'
    AND ad_group.status != 'REMOVED'
    AND segments.date DURING LAST_30_DAYS
  ORDER BY metrics.impressions DESC
  LIMIT 200
`;

const VIEW_QUERY = `
  SELECT ad_group_ad_asset_view.ad_group_ad, ad_group_ad_asset_view.field_type,
    ad_group_ad_asset_view.performance_label, ad_group_ad_asset_view.pinned_field,
    ad_group_ad_asset_view.enabled,
    ad_group_ad_asset_view.policy_summary.approval_status,
    ad_group_ad_asset_view.policy_summary.review_status,
    asset.text_asset.text
  FROM ad_group_ad_asset_view
  WHERE ad_group_ad_asset_view.field_type IN ('HEADLINE', 'DESCRIPTION')
  LIMIT 5000
`;

function labelOf(raw: string): AssetLabel {
  return (ASSET_LABELS as readonly string[]).includes(raw) ? (raw as AssetLabel) : 'UNKNOWN';
}

function pinOf(raw: string): PinField | null {
  return isPinField(raw) ? raw : null;
}

function topicNames(entries: unknown[]): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    const topic = str(entry, 'topic');
    if (/^[A-Za-z0-9_ .:-]{2,80}$/.test(topic)) out.push(topic);
  }
  return out.slice(0, 5);
}

function inlineAssets(entries: unknown[], field: 'HEADLINE' | 'DESCRIPTION'): RsaTextAsset[] {
  const out: RsaTextAsset[] = [];
  for (const entry of entries) {
    const text = str(entry, 'text').trim();
    if (!text) continue;
    out.push({
      text,
      field,
      label: labelOf(enumOf(entry, 'asset_performance_label')),
      pinned_field: pinOf(enumOf(entry, 'pinned_field')),
      approval: enumOf(entry, 'policy_summary_info.approval_status'),
      review: enumOf(entry, 'policy_summary_info.review_status'),
      policy_topics: topicNames(list(entry, 'policy_summary_info.policy_topic_entries')),
    });
  }
  return out;
}

export function normalizeRsaRows(rows: readonly any[]): RsaSummary[] {
  const out: RsaSummary[] = [];
  for (const row of rows ?? []) {
    const resource = str(row, 'ad_group_ad.resource_name');
    if (!resource) continue;
    out.push({
      ad_group_ad: resource,
      ad_id: str(row, 'ad_group_ad.ad.id'),
      campaign: str(row, 'campaign.resource_name'),
      campaign_name: str(row, 'campaign.name'),
      ad_group: str(row, 'ad_group.resource_name'),
      ad_group_name: str(row, 'ad_group.name'),
      status: enumOf(row, 'ad_group_ad.status'),
      ad_strength: enumOf(row, 'ad_group_ad.ad_strength'),
      approval: enumOf(row, 'ad_group_ad.policy_summary.approval_status'),
      review: enumOf(row, 'ad_group_ad.policy_summary.review_status'),
      final_urls: list(row, 'ad_group_ad.ad.final_urls').filter((u): u is string => typeof u === 'string'),
      final_mobile_urls: list(row, 'ad_group_ad.ad.final_mobile_urls').filter((u): u is string => typeof u === 'string'),
      tracking_url_template: str(row, 'ad_group_ad.ad.tracking_url_template'),
      final_url_suffix: str(row, 'ad_group_ad.ad.final_url_suffix'),
      path1: str(row, 'ad_group_ad.ad.responsive_search_ad.path1'),
      path2: str(row, 'ad_group_ad.ad.responsive_search_ad.path2'),
      impressions_30d: num(row, 'metrics.impressions'),
      clicks_30d: num(row, 'metrics.clicks'),
      conversions_30d: num(row, 'metrics.conversions'),
      cost_30d: Math.round((num(row, 'metrics.cost_micros') / 1_000_000) * 100) / 100,
      headlines: inlineAssets(list(row, 'ad_group_ad.ad.responsive_search_ad.headlines'), 'HEADLINE'),
      descriptions: inlineAssets(list(row, 'ad_group_ad.ad.responsive_search_ad.descriptions'), 'DESCRIPTION'),
      labels_from_view: false,
    });
  }
  return out;
}

export type ViewRow = {
  ad_group_ad: string;
  field: 'HEADLINE' | 'DESCRIPTION';
  text: string;
  label: AssetLabel;
  pinned_field: PinField | null;
  enabled: boolean;
  approval: string;
  review: string;
};

export function normalizeViewRows(rows: readonly any[]): ViewRow[] {
  const out: ViewRow[] = [];
  for (const row of rows ?? []) {
    const field = enumOf(row, 'ad_group_ad_asset_view.field_type');
    if (field !== 'HEADLINE' && field !== 'DESCRIPTION') continue;
    const text = str(row, 'asset.text_asset.text').trim();
    const adGroupAd = str(row, 'ad_group_ad_asset_view.ad_group_ad');
    if (!text || !adGroupAd) continue;
    const enabled = pick(row, 'ad_group_ad_asset_view.enabled');
    out.push({
      ad_group_ad: adGroupAd,
      field,
      text,
      label: labelOf(enumOf(row, 'ad_group_ad_asset_view.performance_label')),
      pinned_field: pinOf(enumOf(row, 'ad_group_ad_asset_view.pinned_field')),
      enabled: enabled !== false,
      approval: enumOf(row, 'ad_group_ad_asset_view.policy_summary.approval_status'),
      review: enumOf(row, 'ad_group_ad_asset_view.policy_summary.review_status'),
    });
  }
  return out;
}

/** The view is the source of truth for labels and per-asset policy; the ad's own list keeps the order and the text. */
export function mergeViewIntoRsas(rsas: RsaSummary[], view: readonly ViewRow[]): RsaSummary[] {
  const byAd = new Map<string, ViewRow[]>();
  for (const v of view) {
    const bucket = byAd.get(v.ad_group_ad) ?? [];
    bucket.push(v);
    byAd.set(v.ad_group_ad, bucket);
  }
  return rsas.map((rsa) => {
    const rows = byAd.get(rsa.ad_group_ad);
    if (!rows || rows.length === 0) return rsa;
    const apply = (assets: RsaTextAsset[], field: 'HEADLINE' | 'DESCRIPTION') =>
      assets.map((asset) => {
        const match = rows.find((r) => r.field === field && r.text === asset.text);
        if (!match) return asset;
        return {
          ...asset,
          label: match.label,
          pinned_field: match.pinned_field ?? asset.pinned_field,
          approval: match.approval || asset.approval,
          review: match.review || asset.review,
        };
      });
    return { ...rsa, headlines: apply(rsa.headlines, 'HEADLINE'), descriptions: apply(rsa.descriptions, 'DESCRIPTION'), labels_from_view: true };
  });
}

export type AdAssetReport = {
  rsas: RsaSummary[];
  /** false when the RSA list itself could not be read */
  readable: boolean;
};

export async function readRsaAssets(customer: GaqlReader): Promise<AdAssetReport> {
  let rows: any[];
  try {
    rows = await customer.query(RSA_QUERY);
  } catch {
    return { rsas: [], readable: false };
  }
  let rsas = normalizeRsaRows(rows);
  try {
    rsas = mergeViewIntoRsas(rsas, normalizeViewRows(await customer.query(VIEW_QUERY)));
  } catch {
    // The inline labels from the ad stay; labels_from_view stays false.
  }
  return { rsas, readable: true };
}

/** One ad, read fresh. Used by preflight so the swap is built from the live texts. */
export async function readOneRsa(customer: GaqlReader, adGroupAdResource: string): Promise<RsaSummary | null> {
  const query = RSA_QUERY.replace(
    "WHERE ad_group_ad.ad.type = 'RESPONSIVE_SEARCH_AD'",
    `WHERE ad_group_ad.resource_name = '${esc(adGroupAdResource)}'\n    AND ad_group_ad.ad.type = 'RESPONSIVE_SEARCH_AD'`
  ).replace('LIMIT 200', 'LIMIT 1');
  const rows = await customer.query(query);
  const rsa = normalizeRsaRows(rows)[0];
  if (!rsa) return null;
  try {
    const view = await customer.query(
      VIEW_QUERY.replace(
        'WHERE ad_group_ad_asset_view.field_type',
        `WHERE ad_group_ad_asset_view.ad_group_ad = '${esc(adGroupAdResource)}'\n    AND ad_group_ad_asset_view.field_type`
      )
    );
    return mergeViewIntoRsas([rsa], normalizeViewRows(view))[0];
  } catch {
    return rsa;
  }
}

/** Every non-removed responsive search ad of one ad group (readback and ad tests). */
export async function readAdGroupRsas(customer: GaqlReader, adGroupResource: string): Promise<RsaSummary[]> {
  const query = RSA_QUERY.replace(
    "WHERE ad_group_ad.ad.type = 'RESPONSIVE_SEARCH_AD'",
    `WHERE ad_group_ad.ad_group = '${esc(adGroupResource)}'\n    AND ad_group_ad.ad.type = 'RESPONSIVE_SEARCH_AD'`
  );
  return normalizeRsaRows(await customer.query(query));
}

// ---------------------------------------------------------------------------
// Verdict: which texts are worth replacing
// ---------------------------------------------------------------------------

/** Google needs real traffic before it rates a text; below this the labels are not a decision basis. */
export const MIN_IMPRESSIONS_FOR_LABELS = 1000;
export const MAX_REPLACE_HEADLINES = 5;
export const MAX_REPLACE_DESCRIPTIONS = 2;

export type ReplaceReason = 'low_performance' | 'policy_disapproved';

export type ReplaceCandidate = { text: string; field: 'HEADLINE' | 'DESCRIPTION'; reason: ReplaceReason };

export type AssetVerdict = {
  ad_group_ad: string;
  replace: ReplaceCandidate[];
  keep_best: string[];
  counts: Record<AssetLabel, number>;
  /** why nothing is proposed, when replace is empty */
  skip_reason: 'not_enough_data' | 'nothing_low' | 'ad_not_enabled' | 'would_empty_the_ad' | null;
};

export function emptyCounts(): Record<AssetLabel, number> {
  return { BEST: 0, GOOD: 0, LOW: 0, LEARNING: 0, PENDING: 0, UNKNOWN: 0 };
}

/**
 * Rules: only enabled ads with 1000+ impressions in 30 days; only LOW texts (or
 * disapproved ones); pinned texts are never swapped by the platform (a pin is a
 * deliberate choice); at most 5 headlines and 2 descriptions per change and
 * never more than half of the headlines; the ad must keep at least 3 headlines
 * and 2 descriptions that are not being replaced.
 */
export function assetVerdict(rsa: RsaSummary): AssetVerdict {
  const counts = emptyCounts();
  for (const a of [...rsa.headlines, ...rsa.descriptions]) counts[a.label] += 1;
  const keepBest = [...rsa.headlines, ...rsa.descriptions].filter((a) => a.label === 'BEST').map((a) => a.text);
  const base = { ad_group_ad: rsa.ad_group_ad, counts, keep_best: keepBest };

  if (rsa.status !== 'ENABLED') return { ...base, replace: [], skip_reason: 'ad_not_enabled' };

  const candidates: ReplaceCandidate[] = [];
  const consider = (assets: RsaTextAsset[], field: 'HEADLINE' | 'DESCRIPTION') => {
    for (const a of assets) {
      if (a.pinned_field) continue;
      if (a.approval === 'DISAPPROVED') candidates.push({ text: a.text, field, reason: 'policy_disapproved' });
      else if (a.label === 'LOW' && rsa.impressions_30d >= MIN_IMPRESSIONS_FOR_LABELS) {
        candidates.push({ text: a.text, field, reason: 'low_performance' });
      }
    }
  };
  consider(rsa.headlines, 'HEADLINE');
  consider(rsa.descriptions, 'DESCRIPTION');

  if (candidates.length === 0) {
    return {
      ...base,
      replace: [],
      skip_reason: rsa.impressions_30d < MIN_IMPRESSIONS_FOR_LABELS && counts.LOW > 0 ? 'not_enough_data' : 'nothing_low',
    };
  }

  const headlineCap = Math.min(MAX_REPLACE_HEADLINES, Math.floor(rsa.headlines.length / 2));
  const replace = [
    ...candidates.filter((c) => c.field === 'HEADLINE').slice(0, headlineCap),
    ...candidates.filter((c) => c.field === 'DESCRIPTION').slice(0, MAX_REPLACE_DESCRIPTIONS),
  ];
  const keptHeadlines = rsa.headlines.length - replace.filter((c) => c.field === 'HEADLINE').length;
  const keptDescriptions = rsa.descriptions.length - replace.filter((c) => c.field === 'DESCRIPTION').length;
  if (replace.length === 0 || keptHeadlines < 3 || keptDescriptions < 2) {
    return { ...base, replace: [], skip_reason: 'would_empty_the_ad' };
  }
  return { ...base, replace, skip_reason: null };
}

// ---------------------------------------------------------------------------
// Extension coverage (campaign and account level)
// ---------------------------------------------------------------------------

export type ExtensionKind = 'SITELINK' | 'CALLOUT' | 'STRUCTURED_SNIPPET' | 'CALL';
export const EXTENSION_KINDS: readonly ExtensionKind[] = ['SITELINK', 'CALLOUT', 'STRUCTURED_SNIPPET', 'CALL'];
/** Below these counts a Search campaign is missing assets (Google shows up to 6 sitelinks, 4 callouts of 10). */
export const EXTENSION_MINIMUMS: Readonly<Record<ExtensionKind, number>> = {
  SITELINK: 4,
  CALLOUT: 4,
  STRUCTURED_SNIPPET: 1,
  CALL: 1,
};

export type CampaignCoverage = {
  campaign: string;
  campaign_name: string;
  counts: Record<ExtensionKind, number>;
  missing: ExtensionKind[];
};

const SEARCH_CAMPAIGN_QUERY = `
  SELECT campaign.resource_name, campaign.name
  FROM campaign
  WHERE campaign.status = 'ENABLED' AND campaign.advertising_channel_type = 'SEARCH'
  LIMIT 200
`;
const CAMPAIGN_ASSET_QUERY = `
  SELECT campaign.resource_name, campaign_asset.field_type
  FROM campaign_asset
  WHERE campaign_asset.status = 'ENABLED'
    AND campaign_asset.field_type IN ('SITELINK', 'CALLOUT', 'STRUCTURED_SNIPPET', 'CALL')
  LIMIT 5000
`;
const CUSTOMER_ASSET_QUERY = `
  SELECT customer_asset.field_type
  FROM customer_asset
  WHERE customer_asset.status = 'ENABLED'
    AND customer_asset.field_type IN ('SITELINK', 'CALLOUT', 'STRUCTURED_SNIPPET', 'CALL')
  LIMIT 1000
`;

function zeroCounts(): Record<ExtensionKind, number> {
  return { SITELINK: 0, CALLOUT: 0, STRUCTURED_SNIPPET: 0, CALL: 0 };
}

export function computeCoverage(
  campaigns: ReadonlyArray<{ resource: string; name: string }>,
  campaignAssetRows: readonly any[],
  customerAssetRows: readonly any[]
): CampaignCoverage[] {
  const account = zeroCounts();
  for (const row of customerAssetRows) {
    const kind = enumOf(row, 'customer_asset.field_type') as ExtensionKind;
    if (kind in account) account[kind] += 1;
  }
  const perCampaign = new Map<string, Record<ExtensionKind, number>>();
  for (const row of campaignAssetRows) {
    const campaign = str(row, 'campaign.resource_name');
    const kind = enumOf(row, 'campaign_asset.field_type') as ExtensionKind;
    if (!campaign || !(kind in account)) continue;
    const counts = perCampaign.get(campaign) ?? zeroCounts();
    counts[kind] += 1;
    perCampaign.set(campaign, counts);
  }
  return campaigns.map(({ resource, name }) => {
    const own = perCampaign.get(resource);
    // Account-level assets serve for every campaign without its own of that type.
    const counts = zeroCounts();
    for (const k of EXTENSION_KINDS) counts[k] = (own?.[k] ?? 0) > 0 ? own![k] : account[k];
    const missing = EXTENSION_KINDS.filter((k) => counts[k] < EXTENSION_MINIMUMS[k]);
    return { campaign: resource, campaign_name: name, counts, missing };
  });
}

/** Null when the campaign list or the campaign assets could not be read. */
export async function readExtensionCoverage(customer: GaqlReader): Promise<CampaignCoverage[] | null> {
  try {
    const [campaignRows, campaignAssets] = await Promise.all([
      customer.query(SEARCH_CAMPAIGN_QUERY),
      customer.query(CAMPAIGN_ASSET_QUERY),
    ]);
    const customerAssets = await customer.query(CUSTOMER_ASSET_QUERY).catch(() => null);
    // Without the account-level read we would report assets as missing that do serve: refuse to guess.
    if (customerAssets === null) return null;
    const campaigns = campaignRows
      .map((row) => ({ resource: str(row, 'campaign.resource_name'), name: str(row, 'campaign.name') }))
      .filter((c) => c.resource);
    return computeCoverage(campaigns, campaignAssets, customerAssets);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Compact block for the optimizer snapshot
// ---------------------------------------------------------------------------

export type AdAssetsSnapshot = {
  rsa_count: number;
  labels_from_view: boolean;
  ads: Array<{
    ad_group_ad: string;
    campaign: string;
    ad_group: string;
    ad_strength: string;
    impressions_30d: number;
    best: number;
    good: number;
    low: number;
    learning: number;
    disapproved: number;
    replaceable_headlines: number;
    replaceable_descriptions: number;
    skip_reason: AssetVerdict['skip_reason'];
  }>;
  campaigns_missing_assets: Array<{ campaign: string; campaign_name: string; missing: ExtensionKind[] }>;
};

const SNAPSHOT_ADS = 8;
const SNAPSHOT_CAMPAIGNS = 8;

/** No ad text goes in: texts come from the merchant's site and third parties can influence them. */
export function buildAdAssetsSnapshot(
  report: AdAssetReport,
  coverage: readonly CampaignCoverage[] | null
): AdAssetsSnapshot {
  const ads = report.rsas
    .filter((r) => r.status === 'ENABLED')
    .map((rsa) => {
      const verdict = assetVerdict(rsa);
      return {
        ad_group_ad: rsa.ad_group_ad,
        campaign: rsa.campaign,
        ad_group: rsa.ad_group,
        ad_strength: rsa.ad_strength || 'UNKNOWN',
        impressions_30d: rsa.impressions_30d,
        best: verdict.counts.BEST,
        good: verdict.counts.GOOD,
        low: verdict.counts.LOW,
        learning: verdict.counts.LEARNING + verdict.counts.PENDING,
        disapproved: [...rsa.headlines, ...rsa.descriptions].filter((a) => a.approval === 'DISAPPROVED').length,
        replaceable_headlines: verdict.replace.filter((c) => c.field === 'HEADLINE').length,
        replaceable_descriptions: verdict.replace.filter((c) => c.field === 'DESCRIPTION').length,
        skip_reason: verdict.skip_reason,
      };
    })
    .sort(
      (a, b) =>
        b.replaceable_headlines + b.replaceable_descriptions - (a.replaceable_headlines + a.replaceable_descriptions) ||
        b.impressions_30d - a.impressions_30d
    )
    .slice(0, SNAPSHOT_ADS);
  return {
    rsa_count: report.rsas.length,
    labels_from_view: report.rsas.some((r) => r.labels_from_view),
    ads,
    campaigns_missing_assets: (coverage ?? [])
      .filter((c) => c.missing.length > 0)
      .slice(0, SNAPSHOT_CAMPAIGNS)
      .map((c) => ({ campaign: c.campaign, campaign_name: c.campaign_name, missing: c.missing })),
  };
}

// ---------------------------------------------------------------------------
// Performance Max asset groups (status, policy, ad strength; no per-asset label in v22)
// ---------------------------------------------------------------------------

export type AssetGroupSummary = {
  asset_group: string;
  name: string;
  campaign: string;
  ad_strength: string;
  primary_status: string;
  disapproved_assets: number;
  limited_assets: number;
  per_field: Record<string, number>;
};

const ASSET_GROUP_QUERY = `
  SELECT asset_group.resource_name, asset_group.name, asset_group.campaign,
    asset_group.ad_strength, asset_group.primary_status
  FROM asset_group
  WHERE asset_group.status != 'REMOVED'
  LIMIT 200
`;
const ASSET_GROUP_ASSET_QUERY = `
  SELECT asset_group_asset.asset_group, asset_group_asset.field_type, asset_group_asset.status,
    asset_group_asset.primary_status, asset_group_asset.policy_summary.approval_status
  FROM asset_group_asset
  WHERE asset_group_asset.status != 'REMOVED'
  LIMIT 5000
`;

export function summarizeAssetGroups(groupRows: readonly any[], assetRows: readonly any[]): AssetGroupSummary[] {
  const groups = new Map<string, AssetGroupSummary>();
  for (const row of groupRows) {
    const resource = str(row, 'asset_group.resource_name');
    if (!resource) continue;
    groups.set(resource, {
      asset_group: resource,
      name: str(row, 'asset_group.name'),
      campaign: str(row, 'asset_group.campaign'),
      ad_strength: enumOf(row, 'asset_group.ad_strength') || 'UNKNOWN',
      primary_status: enumOf(row, 'asset_group.primary_status'),
      disapproved_assets: 0,
      limited_assets: 0,
      per_field: {},
    });
  }
  for (const row of assetRows) {
    const g = groups.get(str(row, 'asset_group_asset.asset_group'));
    if (!g) continue;
    const field = enumOf(row, 'asset_group_asset.field_type') || 'UNKNOWN';
    g.per_field[field] = (g.per_field[field] ?? 0) + 1;
    if (enumOf(row, 'asset_group_asset.policy_summary.approval_status') === 'DISAPPROVED') g.disapproved_assets += 1;
    if (enumOf(row, 'asset_group_asset.primary_status') === 'LIMITED') g.limited_assets += 1;
  }
  return [...groups.values()];
}

export async function readAssetGroups(customer: GaqlReader): Promise<AssetGroupSummary[] | null> {
  try {
    const [groups, assets] = await Promise.all([customer.query(ASSET_GROUP_QUERY), customer.query(ASSET_GROUP_ASSET_QUERY)]);
    return summarizeAssetGroups(groups, assets);
  } catch {
    return null;
  }
}
