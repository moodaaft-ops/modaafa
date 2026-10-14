import type { GaqlCustomer } from '@/lib/jarvis/tools/types';
import { classifyActor } from '@/lib/jarvis/tools/get-change-history';
import { addDays, bool, currencyUnits, money, num, num0, pick, round, str, utcDate } from '@/lib/jarvis/tools/shared';
import { SIGNAL_KEYS } from './signals-store';
import type {
  AccountSignals,
  CampaignKind,
  CampaignSignal,
  ConversionGroup,
  HourSignal,
  ProductSignal,
  SignalKey,
  SignalRead,
} from './types';

/** Overall budget for one read; a query still running at the deadline counts as failed. */
export const SIGNALS_TIMEOUT_MS = 6000;

/** Modaafa's own MCC: a link to it is never an outside agency. */
export const MODAAFA_MCC_ID = '7561141000';

export type ReadSignalsContext = {
  /** 10 digits, no dashes. */
  customerId: string;
  currency: string;
  /** The email the account was connected with; edits by it are not «someone else». */
  connectedEmail: string | null;
  /** Manager ids that are ours (Modaafa's MCC, GOOGLE_ADS_MANAGER_IDS): a link to them is not an outside agency. */
  ownManagerIds: string[];
  timeoutMs?: number;
  now?: Date;
};

/** Modaafa's MCC plus every configured manager id, digits only, no repeats. */
export function ownManagerIdsFrom(configured: Array<string | null | undefined> = []) {
  const ids = [MODAAFA_MCC_ID, ...configured].map((id) => String(id ?? '').replace(/\D/g, '')).filter(Boolean);
  return Array.from(new Set(ids));
}

// ---------------------------------------------------------------------------
// GAQL. One constant per query so the operator page, the tests and the report
// all talk about the same text.
// ---------------------------------------------------------------------------

const CHANGE_WINDOW_DAYS = 14;

/**
 * Google rejects a WHERE filter on a field of a resource other than the FROM
 * resource unless that field is also selected
 * (EXPECTED_REFERENCED_FIELD_IN_SELECT_CLAUSE, seen live on campaign_asset on
 * 14 Oct 2026). Every such field below is selected, even where the answer
 * does not read it.
 */
export const SIGNAL_GAQL = {
  /** Metrics-free, so a campaign with no activity still appears. */
  campaignList: `
    SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type
    FROM campaign
    WHERE campaign.status != 'REMOVED'
    ORDER BY campaign.id
    LIMIT 1000`,
  campaignMetrics: `
    SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
      metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value
    FROM campaign
    WHERE segments.date DURING LAST_30_DAYS AND campaign.status != 'REMOVED'
    ORDER BY metrics.cost_micros DESC
    LIMIT 1000`,
  enabledConversionActions: `
    SELECT conversion_action.resource_name, conversion_action.status
    FROM conversion_action
    WHERE conversion_action.status = 'ENABLED'
    LIMIT 100`,
  conversionsByCategory: `
    SELECT segments.conversion_action_category, metrics.conversions
    FROM customer
    WHERE segments.date DURING LAST_30_DAYS
    LIMIT 100`,
  /** Also tells us whether the id is a manager account (then nothing below means anything). */
  customer: `
    SELECT customer.id, customer.manager, customer.auto_tagging_enabled
    FROM customer
    LIMIT 1`,
  adFinalUrls: `
    SELECT ad_group_ad.ad.final_urls, ad_group_ad.status, campaign.status
    FROM ad_group_ad
    WHERE ad_group_ad.status = 'ENABLED' AND campaign.status = 'ENABLED'
    LIMIT 200`,
  assetGroupFinalUrls: `
    SELECT asset_group.final_urls, asset_group.status, campaign.status
    FROM asset_group
    WHERE asset_group.status = 'ENABLED' AND campaign.status = 'ENABLED'
    LIMIT 50`,
  merchantCenter: `
    SELECT campaign.id, campaign.shopping_setting.merchant_id
    FROM campaign
    WHERE campaign.status != 'REMOVED'
    LIMIT 1000`,
  customerAssets: `
    SELECT customer_asset.field_type, customer_asset.status
    FROM customer_asset
    WHERE customer_asset.status = 'ENABLED'
    LIMIT 1000`,
  campaignAssets: `
    SELECT campaign_asset.field_type, campaign_asset.status, campaign.status
    FROM campaign_asset
    WHERE campaign_asset.status = 'ENABLED' AND campaign.status = 'ENABLED'
    LIMIT 2000`,
  /**
   * A location is on the account when a LOCATION_SYNC asset set (the Google Business Profile sync) is
   * linked to it and both the link and the set are enabled. There is no LOCATION asset field type, so
   * customer_asset and campaign_asset never show one; the link tables are the only place to look.
   */
  customerLocationSets: `
    SELECT asset_set.id, asset_set.type, asset_set.status, customer_asset_set.status
    FROM customer_asset_set
    WHERE customer_asset_set.status = 'ENABLED'
      AND asset_set.status = 'ENABLED'
      AND asset_set.type = 'LOCATION_SYNC'
    LIMIT 50`,
  campaignLocationSets: `
    SELECT asset_set.id, asset_set.type, asset_set.status, campaign_asset_set.status, campaign.status
    FROM campaign_asset_set
    WHERE campaign_asset_set.status = 'ENABLED'
      AND asset_set.status = 'ENABLED'
      AND asset_set.type = 'LOCATION_SYNC'
      AND campaign.status = 'ENABLED'
    LIMIT 200`,
  targetedLocations: `
    SELECT campaign_criterion.location.geo_target_constant, campaign.status
    FROM campaign_criterion
    WHERE campaign_criterion.type = 'LOCATION'
      AND campaign_criterion.negative = FALSE
      AND campaign_criterion.status != 'REMOVED'
      AND campaign.status = 'ENABLED'
    LIMIT 500`,
  geoNames: (resourceNames: string[]) => `
    SELECT geo_target_constant.resource_name, geo_target_constant.name
    FROM geo_target_constant
    WHERE geo_target_constant.resource_name IN (${resourceNames.map((name) => `'${name}'`).join(', ')})`,
  managerLinks: `
    SELECT customer_manager_link.manager_customer, customer_manager_link.status
    FROM customer_manager_link
    LIMIT 50`,
  /**
   * change_event wants an explicit window (Google documents it with >= and <=
   * on change_date_time, at most 30 days back, and a LIMIT of 10000 or less).
   * The upper bound is tomorrow so today's edits are inside it.
   */
  changeEvents: (now: Date) => `
    SELECT change_event.user_email, change_event.client_type
    FROM change_event
    WHERE change_event.change_date_time >= '${addDays(utcDate(now), -CHANGE_WINDOW_DAYS)}'
      AND change_event.change_date_time <= '${addDays(utcDate(now), 1)}'
    ORDER BY change_event.change_date_time DESC
    LIMIT 1000`,
  hours: `
    SELECT segments.hour, metrics.cost_micros, metrics.clicks, metrics.conversions, metrics.phone_calls
    FROM campaign
    WHERE segments.date DURING LAST_30_DAYS AND campaign.status = 'ENABLED'`,
  /** Same as `hours` without the call metric, for accounts where Google refuses that combination. */
  hoursWithoutCalls: `
    SELECT segments.hour, metrics.cost_micros, metrics.clicks, metrics.conversions
    FROM campaign
    WHERE segments.date DURING LAST_30_DAYS AND campaign.status = 'ENABLED'`,
  products: `
    SELECT segments.product_item_id, segments.product_title,
      metrics.cost_micros, metrics.conversions, metrics.conversions_value
    FROM shopping_performance_view
    WHERE segments.date DURING LAST_30_DAYS
    ORDER BY metrics.cost_micros DESC
    LIMIT 50`,
} as const;

// ---------------------------------------------------------------------------
// Deadline and failure codes
// ---------------------------------------------------------------------------

class SignalTimeout extends Error {
  constructor() {
    super('timeout');
    this.name = 'SignalTimeout';
  }
}

/** A query that answered, but not with what the signal needs. Carries a short code, never data. */
class SignalShape extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'SignalShape';
    this.code = code;
  }
}

const GOOGLE_CODE = /^[A-Z][A-Z0-9_]{2,79}$/;

/**
 * A short code for a failed signal. Google's own error enum (a fixed word like
 * UNRECOGNIZED_FIELD, never customer data) is kept after the colon so the
 * operator page can tell a rejected field from a dead network.
 */
function failureCode(error: unknown): string {
  if (error instanceof SignalTimeout) return 'timeout';
  if (error instanceof SignalShape) return error.code;
  const codes = (error as { codes?: unknown } | null)?.codes;
  if (Array.isArray(codes)) {
    const google = codes.find((code): code is string => typeof code === 'string' && GOOGLE_CODE.test(code));
    if (google) return `query_failed:${google}`;
  }
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) return `query_failed:http_${status}`;
  return 'query_failed';
}

function isTimeout(error: unknown) {
  return error instanceof SignalTimeout;
}

// ---------------------------------------------------------------------------
// Row helpers
// ---------------------------------------------------------------------------

type Query = (gaql: string) => Promise<any[]>;

const NAME_MAX = 120;

function cleanName(value: string) {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
}

function channelKind(raw: string): CampaignKind {
  switch (raw) {
    case 'SEARCH':
    case 'DISPLAY':
    case 'SHOPPING':
    case 'VIDEO':
    case 'LOCAL':
    case 'DEMAND_GEN':
      return raw;
    case 'PERFORMANCE_MAX':
      return 'PMAX';
    case 'MULTI_CHANNEL':
      return 'APP';
    default:
      return 'OTHER';
  }
}

function campaignStatus(raw: string): CampaignSignal['status'] {
  return raw === 'ENABLED' ? 'ENABLED' : raw === 'PAUSED' ? 'PAUSED' : 'OTHER';
}

/** Google's ConversionActionCategory folded into the groups the tree uses. */
const CATEGORY_GROUP: Record<string, ConversionGroup> = {
  PURCHASE: 'purchase',
  ADD_TO_CART: 'purchase',
  BEGIN_CHECKOUT: 'purchase',
  STORE_SALE: 'purchase',
  SUBMIT_LEAD_FORM: 'lead_form',
  QUALIFIED_LEAD: 'lead_form',
  CONVERTED_LEAD: 'lead_form',
  IMPORTED_LEAD: 'lead_form',
  PHONE_CALL_LEAD: 'call',
  BOOK_APPOINTMENT: 'booking',
  REQUEST_QUOTE: 'booking',
  GET_DIRECTIONS: 'directions',
  STORE_VISIT: 'store_visit',
  CONTACT: 'contact',
  SIGNUP: 'signup',
  SUBSCRIBE_PAID: 'signup',
  PAGE_VIEW: 'page_view',
  ENGAGEMENT: 'page_view',
};

export function conversionGroupOf(category: string): ConversionGroup {
  return CATEGORY_GROUP[category] ?? 'other';
}

function hostOf(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  try {
    const host = new URL(withScheme).hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
    return host.includes('.') ? host : null;
  } catch {
    return null;
  }
}

function urlList(row: unknown, path: string): unknown[] {
  const raw = pick(row, path);
  if (Array.isArray(raw)) return raw;
  return typeof raw === 'string' ? [raw] : [];
}

const GEO_RESOURCE = /^geoTargetConstants\/\d{1,12}$/;
const MAX_PLACES = 12;

function digitsOf(value: string) {
  return value.replace(/\D/g, '');
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

async function readCampaigns(q: Query): Promise<CampaignSignal[]> {
  // Both queries must answer: a campaign list without its metrics would say
  // «zero spend» for an account that spends, and the reverse would hide the
  // campaigns that have no activity at all.
  const [list, metrics] = await Promise.all([q(SIGNAL_GAQL.campaignList), q(SIGNAL_GAQL.campaignMetrics)]);
  const byId = new Map<string, CampaignSignal>();

  const upsert = (row: unknown) => {
    const id = str(row, 'campaign.id');
    const rawStatus = str(row, 'campaign.status');
    if (!id || rawStatus === 'REMOVED') return null;
    let campaign = byId.get(id);
    if (!campaign) {
      campaign = {
        id,
        name: cleanName(str(row, 'campaign.name')),
        kind: channelKind(str(row, 'campaign.advertising_channel_type')),
        status: campaignStatus(rawStatus),
        cost30: 0,
        impressions30: 0,
        clicks30: 0,
        conversions30: 0,
        value30: 0,
      };
      byId.set(id, campaign);
    }
    return campaign;
  };

  for (const row of list) upsert(row);
  for (const row of metrics) {
    const campaign = upsert(row);
    if (!campaign) continue;
    campaign.cost30 += currencyUnits(row, 'metrics.cost_micros');
    campaign.impressions30 += num0(row, 'metrics.impressions');
    campaign.clicks30 += num0(row, 'metrics.clicks');
    campaign.conversions30 += num0(row, 'metrics.conversions');
    campaign.value30 += num0(row, 'metrics.conversions_value');
  }

  return Array.from(byId.values())
    .map((campaign) => ({
      ...campaign,
      cost30: money(campaign.cost30),
      impressions30: Math.round(campaign.impressions30),
      clicks30: Math.round(campaign.clicks30),
      conversions30: round(campaign.conversions30, 2),
      value30: money(campaign.value30),
    }))
    .sort((a, b) => b.cost30 - a.cost30 || a.id.localeCompare(b.id));
}

async function readEnabledConversionActions(q: Query): Promise<number> {
  const rows = await q(SIGNAL_GAQL.enabledConversionActions);
  return rows.length;
}

async function readConversionsByGroup(q: Query): Promise<Array<{ group: ConversionGroup; conversions: number }>> {
  const rows = await q(SIGNAL_GAQL.conversionsByCategory);
  const totals = new Map<ConversionGroup, number>();
  for (const row of rows) {
    const conversions = num0(row, 'metrics.conversions');
    if (!(conversions > 0)) continue;
    const group = conversionGroupOf(str(row, 'segments.conversion_action_category'));
    totals.set(group, (totals.get(group) ?? 0) + conversions);
  }
  return Array.from(totals.entries())
    .map(([group, conversions]) => ({ group, conversions: round(conversions, 2) }))
    .sort((a, b) => b.conversions - a.conversions || a.group.localeCompare(b.group));
}

async function readLandingHosts(q: Query): Promise<string[]> {
  const [ads, groups] = await Promise.allSettled([q(SIGNAL_GAQL.adFinalUrls), q(SIGNAL_GAQL.assetGroupFinalUrls)]);
  const counts = new Map<string, number>();
  const count = (rows: any[], path: string) => {
    for (const row of rows) {
      for (const url of urlList(row, path)) {
        const host = hostOf(url);
        if (host) counts.set(host, (counts.get(host) ?? 0) + 1);
      }
    }
  };
  if (ads.status === 'fulfilled') count(ads.value, 'ad_group_ad.ad.final_urls');
  if (groups.status === 'fulfilled') count(groups.value, 'asset_group.final_urls');

  // One query alone is enough, but only when it found something. An empty
  // answer next to a failed one is «we could not see», not «no site».
  if (counts.size === 0) {
    const failed = ads.status === 'rejected' ? ads.reason : groups.status === 'rejected' ? groups.reason : null;
    if (failed) throw failed;
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([host]) => host);
}

async function readMerchantCenterLinked(q: Query): Promise<boolean> {
  const rows = await q(SIGNAL_GAQL.merchantCenter);
  return rows.some((row) => {
    const id = num(row, 'campaign.shopping_setting.merchant_id');
    return id !== null && id > 0;
  });
}

async function readAssets(q: Query): Promise<{ call: boolean; locations: number }> {
  const [customerAssets, campaignAssets, customerSets, campaignSets] = await Promise.allSettled([
    q(SIGNAL_GAQL.customerAssets),
    q(SIGNAL_GAQL.campaignAssets),
    q(SIGNAL_GAQL.customerLocationSets),
    q(SIGNAL_GAQL.campaignLocationSets),
  ]);
  // The call answer needs both asset queries; the location sets are a bonus
  // (Google has no LOCATION asset field type: locations are linked as asset sets).
  if (customerAssets.status === 'rejected') throw customerAssets.reason;
  if (campaignAssets.status === 'rejected') throw campaignAssets.reason;

  let call = false;
  for (const row of customerAssets.value) {
    if (str(row, 'customer_asset.field_type') === 'CALL') call = true;
  }
  for (const row of campaignAssets.value) {
    if (str(row, 'campaign_asset.field_type') === 'CALL') call = true;
  }

  // Distinct enabled location sets linked at account level or to an enabled campaign. The same set linked
  // to three campaigns is one location source, not three.
  const linked = new Set<string>();
  for (const result of [customerSets, campaignSets]) {
    if (result.status === 'rejected') {
      console.warn('[onboarding-signals] assets location sets failed');
      continue;
    }
    for (const row of result.value) {
      if (str(row, 'asset_set.type') !== 'LOCATION_SYNC') continue;
      const id = str(row, 'asset_set.id');
      if (id) linked.add(id);
    }
  }
  return { call, locations: linked.size };
}

async function readTargetedPlaces(q: Query): Promise<string[]> {
  const rows = await q(SIGNAL_GAQL.targetedLocations);
  const counts = new Map<string, number>();
  for (const row of rows) {
    const resource = str(row, 'campaign_criterion.location.geo_target_constant');
    // Only this exact shape is ever put inside the next query's text.
    if (GEO_RESOURCE.test(resource)) counts.set(resource, (counts.get(resource) ?? 0) + 1);
  }
  const top = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_PLACES)
    .map(([resource]) => resource);
  if (top.length === 0) return [];

  const nameRows = await q(SIGNAL_GAQL.geoNames(top));
  const names = new Map<string, string>();
  for (const row of nameRows) {
    const name = cleanName(str(row, 'geo_target_constant.name'));
    if (name) names.set(str(row, 'geo_target_constant.resource_name'), name);
  }
  return top.flatMap((resource) => {
    const name = names.get(resource);
    return name ? [name] : [];
  });
}

async function readExternalManager(q: Query, ownManagerIds: string[]): Promise<{ linked: boolean; managerIds: string[] }> {
  const own = new Set(ownManagerIds.map(digitsOf).filter(Boolean));
  const rows = await q(SIGNAL_GAQL.managerLinks);
  const external = new Set<string>();
  for (const row of rows) {
    if (str(row, 'customer_manager_link.status') !== 'ACTIVE') continue;
    const id = digitsOf(str(row, 'customer_manager_link.manager_customer'));
    if (id && !own.has(id)) external.add(id);
  }
  const managerIds = Array.from(external).sort().slice(0, 10);
  return { linked: managerIds.length > 0, managerIds };
}

async function readOtherEditors(q: Query, ctx: ReadSignalsContext, now: Date): Promise<number> {
  const rows = await q(SIGNAL_GAQL.changeEvents(now));
  const editors = new Set<string>();
  for (const row of rows) {
    const email = str(row, 'change_event.user_email').trim().toLowerCase();
    // An edit with no name behind it (Google's own systems) is nobody to ask about.
    if (!email) continue;
    if (classifyActor(email, str(row, 'change_event.client_type'), ctx.connectedEmail) === 'other_user') editors.add(email);
  }
  return editors.size;
}

async function readHours(q: Query): Promise<HourSignal[]> {
  let rows: any[];
  let withCalls = true;
  try {
    rows = await q(SIGNAL_GAQL.hours);
  } catch (error) {
    // Not every account lets call metrics be split by hour. Spend, clicks and
    // conversions by hour are what the decision needs; calls stay at zero.
    if (isTimeout(error)) throw error;
    console.warn('[onboarding-signals] hours without call metric');
    withCalls = false;
    rows = await q(SIGNAL_GAQL.hoursWithoutCalls);
  }
  const hours: HourSignal[] = Array.from({ length: 24 }, (_, hour) => ({ hour, cost: 0, clicks: 0, conversions: 0, phoneCalls: 0 }));
  for (const row of rows) {
    const hour = num(row, 'segments.hour');
    if (hour === null || !Number.isInteger(hour) || hour < 0 || hour > 23) continue;
    const slot = hours[hour];
    slot.cost += currencyUnits(row, 'metrics.cost_micros');
    slot.clicks += num0(row, 'metrics.clicks');
    slot.conversions += num0(row, 'metrics.conversions');
    if (withCalls) slot.phoneCalls += num0(row, 'metrics.phone_calls');
  }
  return hours.map((slot) => ({
    hour: slot.hour,
    cost: money(slot.cost),
    clicks: Math.round(slot.clicks),
    conversions: round(slot.conversions, 2),
    phoneCalls: Math.round(slot.phoneCalls),
  }));
}

async function readProducts(q: Query): Promise<ProductSignal[]> {
  const rows = await q(SIGNAL_GAQL.products);
  const byId = new Map<string, ProductSignal>();
  for (const row of rows) {
    const id = str(row, 'segments.product_item_id').trim().slice(0, 200);
    if (!id) continue;
    const title = cleanName(str(row, 'segments.product_title'));
    const product = byId.get(id) ?? { id, title, cost30: 0, conversions30: 0, value30: 0 };
    if (!product.title && title) product.title = title;
    product.cost30 += currencyUnits(row, 'metrics.cost_micros');
    product.conversions30 += num0(row, 'metrics.conversions');
    product.value30 += num0(row, 'metrics.conversions_value');
    byId.set(id, product);
  }
  return Array.from(byId.values())
    .map((product) => ({
      ...product,
      title: product.title || product.id,
      cost30: money(product.cost30),
      conversions30: round(product.conversions30, 2),
      value30: money(product.value30),
    }))
    .sort((a, b) => b.cost30 - a.cost30 || a.id.localeCompare(b.id))
    .slice(0, 50);
}

// ---------------------------------------------------------------------------
// The read
// ---------------------------------------------------------------------------

/**
 * Reads every signal in parallel, each query on its own with its own catch,
 * inside one overall deadline. Never throws: a query that fails, answers with
 * something unusable or is still running at the deadline makes its signal
 * `{ ok: false, error }` and nothing else. Logs carry the signal key and the
 * code only, never account data.
 */
export async function readAccountSignals(customer: GaqlCustomer, ctx: ReadSignalsContext): Promise<AccountSignals> {
  const timeoutMs = Number.isFinite(ctx.timeoutMs) && (ctx.timeoutMs as number) > 0 ? (ctx.timeoutMs as number) : SIGNALS_TIMEOUT_MS;
  const now = ctx.now ?? new Date();

  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(new SignalTimeout());
    }, timeoutMs);
  });
  // Raced by every query below; this keeps a deadline nobody is racing at that moment from being «unhandled».
  deadline.catch(() => undefined);

  // Every query goes through here, so the deadline covers each one separately
  // and a signal that already has an answer can still finish after it passes.
  const q: Query = async (gaql) => {
    if (expired) throw new SignalTimeout();
    const rows = await Promise.race([Promise.resolve().then(() => customer.query(gaql)), deadline]);
    return Array.isArray(rows) ? rows : [];
  };

  async function read<T>(key: SignalKey, work: () => Promise<T>): Promise<SignalRead<T>> {
    try {
      return { ok: true, value: await work() };
    } catch (error) {
      const code = failureCode(error);
      console.warn(`[onboarding-signals] ${key} failed: ${code}`);
      return { ok: false, error: code };
    }
  }

  let isManager = false;
  try {
    const [
      campaigns,
      enabledConversionActions,
      conversionsByGroup,
      autoTagging,
      landingHosts,
      merchantCenterLinked,
      assets,
      targetedPlaces,
      externalManager,
      otherEditors14d,
      hours,
      products,
    ] = await Promise.all([
      read('campaigns', () => readCampaigns(q)),
      read('enabledConversionActions', () => readEnabledConversionActions(q)),
      read('conversionsByGroup', () => readConversionsByGroup(q)),
      read('autoTagging', async () => {
        const rows = await q(SIGNAL_GAQL.customer);
        const row = rows[0];
        if (!row) throw new SignalShape('no_row');
        if (bool(row, 'customer.manager') === true) isManager = true;
        const value = bool(row, 'customer.auto_tagging_enabled');
        if (value === null) throw new SignalShape('no_value');
        return value;
      }),
      read('landingHosts', () => readLandingHosts(q)),
      read('merchantCenterLinked', () => readMerchantCenterLinked(q)),
      read('assets', () => readAssets(q)),
      read('targetedPlaces', () => readTargetedPlaces(q)),
      read('externalManager', () => readExternalManager(q, ctx.ownManagerIds)),
      read('otherEditors14d', () => readOtherEditors(q, ctx, now)),
      read('hours', () => readHours(q)),
      read('products', () => readProducts(q)),
    ]);

    const signals: AccountSignals = {
      version: 1,
      readAt: (ctx.now ?? new Date()).toISOString(),
      customerId: digitsOf(ctx.customerId),
      currency: /^[A-Z]{3}$/.test(String(ctx.currency).toUpperCase()) ? String(ctx.currency).toUpperCase() : 'SAR',
      campaigns,
      enabledConversionActions,
      conversionsByGroup,
      autoTagging,
      landingHosts,
      merchantCenterLinked,
      assets,
      targetedPlaces,
      externalManager,
      otherEditors14d,
      hours,
      products,
    };

    if (isManager) {
      // A manager account has no campaigns of its own: «no campaigns» would
      // read as a new account. Nothing from it may drive a branch.
      console.warn('[onboarding-signals] manager account, every signal dropped');
      for (const key of SIGNAL_KEYS) (signals as Record<SignalKey, SignalRead<unknown>>)[key] = { ok: false, error: 'manager_account' };
    }
    return signals;
  } catch {
    // Nothing above can throw (every signal has its own catch). This is the
    // promise that the function never does, whatever the caller handed us.
    console.warn('[onboarding-signals] read failed: read_failed');
    return emptySignals(ctx, now, 'read_failed');
  } finally {
    clearTimeout(timer);
  }
}

function emptySignals(ctx: ReadSignalsContext, now: Date, error: string): AccountSignals {
  const fail = { ok: false as const, error };
  return {
    version: 1,
    readAt: now.toISOString(),
    customerId: digitsOf(String(ctx.customerId ?? '')),
    currency: 'SAR',
    campaigns: fail,
    enabledConversionActions: fail,
    conversionsByGroup: fail,
    autoTagging: fail,
    landingHosts: fail,
    merchantCenterLinked: fail,
    assets: fail,
    targetedPlaces: fail,
    externalManager: fail,
    otherEditors14d: fail,
    hours: fail,
    products: fail,
  };
}
