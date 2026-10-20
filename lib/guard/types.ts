/**
 * Shared vocabulary of the morning guard. Everything a detector reads is in
 * GuardSignals; everything it says is a GuardFinding. No detector touches the
 * network or the clock, so each one is tested with a fixture.
 */
export type GuardSeverity = 'critical' | 'high' | 'medium' | 'info';

export const GUARD_CODES = [
  'account_status',
  'billing_setup',
  'billing_budget',
  'spend_zero',
  'spend_spike',
  'cpa_spike',
  'conversions_zero',
  'ad_policy',
  'outside_change',
  // SHOPPING_HEALTH_ENABLED: a large share of the feed's products is not eligible.
  'product_disapprovals',
] as const;
export type GuardCode = (typeof GUARD_CODES)[number];

/** Where each code's evidence is read from. A failed read must not close findings of its codes. */
export type GuardSource = 'status' | 'daily' | 'campaigns' | 'ads' | 'billing' | 'changes';
/** `shopping` is read only under SHOPPING_HEALTH_ENABLED, so it may be absent: absent means unknown. */
export type GuardOk = Record<GuardSource, boolean> & { shopping?: boolean };
export const CODE_SOURCE: Record<GuardCode, GuardSource | 'shopping'> = {
  account_status: 'status',
  billing_setup: 'billing',
  billing_budget: 'billing',
  spend_zero: 'daily',
  spend_spike: 'daily',
  cpa_spike: 'daily',
  conversions_zero: 'daily',
  ad_policy: 'ads',
  outside_change: 'changes',
  product_disapprovals: 'shopping',
};

export const CAUSE_CODES = [
  'tracking',
  'recent_change',
  'billing',
  'budget_limit',
  'campaign_state',
  'bidding',
  'disapproval',
  'auction',
  'unknown',
] as const;
export type CauseCode = (typeof CAUSE_CODES)[number];

export type GuardCause = {
  code: CauseCode;
  /** One short Arabic line: the most likely cause. */
  labelAr: string;
  /** The step that goes with this cause. */
  stepAr: string;
  evidence: Record<string, unknown>;
};

export type GuardEntityType = 'account' | 'campaign' | 'ad_group_ads' | 'change';

export type GuardFinding = {
  code: GuardCode;
  severity: GuardSeverity;
  entityType: GuardEntityType;
  entityId: string;
  entityName: string | null;
  /** "وش صار": one line. */
  whatAr: string;
  /** "وش الخطوة": one line. */
  stepAr: string;
  /** The numbers behind the line. */
  evidence: Record<string, unknown>;
  /** Same key = same alert. A repeat of an open key is never re-sent. */
  dedupeKey: string;
  /** 'human' = route to the agency on WhatsApp, never act automatically. */
  escalation: 'none' | 'human';
  cause: GuardCause | null;
};

export type DailyRow = {
  campaignId: string;
  campaignName: string;
  /** YYYY-MM-DD in the account time zone. */
  date: string;
  cost: number;
  conversions: number;
  clicks: number;
  impressions: number;
};

export type CampaignInfo = {
  id: string;
  name: string;
  status: string;
  dailyBudget: number | null;
  primaryStatus: string | null;
  primaryReasons: string[];
  /** Search impression share lost to budget and to rank, yesterday. 0..1, null when Google reports none. */
  budgetLostIs: number | null;
  rankLostIs: number | null;
  impressionShare: number | null;
  /** Same, averaged over the 14 days before yesterday. */
  baselineImpressionShare: number | null;
};

export type AdPolicyRow = {
  adId: string;
  campaignId: string;
  campaignName: string;
  approval: 'DISAPPROVED' | 'APPROVED_LIMITED';
  topics: string[];
};

export type BillingSignals = {
  /** billing_setup.status values, one per setup. */
  setupStatuses: string[];
  budgets: Array<{
    name: string;
    status: string;
    /** In account currency units. null = no limit (infinite) or not reported. */
    limit: number | null;
    served: number;
    /** Epoch ms of the approved end, null when open ended. */
    endsAt: number | null;
  }>;
};

export type ChangeRow = {
  /** Epoch ms. */
  at: number;
  clientType: string;
  resourceType: string;
  operation: string;
  resourceName: string;
  campaignId: string | null;
  campaignName: string | null;
  fields: string;
};

/** What our own execution log says we changed: timestamps (ms) and the resources named in rollback payloads. */
export type OwnAction = { at: number[]; resources: string[] };

export type GuardSignals = {
  accountId: string;
  customerId: string;
  currency: string;
  timeZone: string;
  now: Date;
  /** YYYY-MM-DD in the account zone. */
  today: string;
  yesterday: string;
  /** customer.status, or the stored google_status when Google could not be asked. */
  googleStatus: string | null;
  daily: DailyRow[];
  campaigns: CampaignInfo[];
  ads: AdPolicyRow[];
  billing: BillingSignals | null;
  changes: ChangeRow[];
  ownActions: OwnAction[];
  /** Which reads worked. A false source means "unknown", never "all clear". */
  ok: GuardOk;
  /** Merchant Center product status (SHOPPING_HEALTH_ENABLED). Absent or null = not read. */
  shopping?: import('../shopping/reader').ShoppingHealth | null;
};
