/**
 * Adaptive onboarding: the shared contract (design in claude/107, approved by
 * Ayman 14 Oct 2026). Three parts build against these types:
 *
 * - signals.ts / signals-store.ts read the Google Ads account once and keep the
 *   result in `job_runs` (no migration).
 * - scenario.ts, bank.ts, opener.ts, understanding.ts, decisions.ts,
 *   endings.ts and answers.ts are pure rules over those signals and the
 *   customer's answers. No model call anywhere: before a subscription the only
 *   AI spend allowed is the free audit.
 * - lib/setup/load.ts and app/onboarding/setup/* render the result behind
 *   ADAPTIVE_ONBOARDING (flag.ts).
 *
 * A signal that failed to read is `{ ok: false }` and every branch that would
 * lean on it falls back to asking the customer instead of guessing.
 */

// ---------------------------------------------------------------------------
// Signals read from the account
// ---------------------------------------------------------------------------

export type SignalRead<T> = { ok: true; value: T } | { ok: false; error?: string };

export type CampaignKind =
  | 'SEARCH'
  | 'PMAX'
  | 'SHOPPING'
  | 'DISPLAY'
  | 'VIDEO'
  | 'LOCAL'
  | 'DEMAND_GEN'
  | 'APP'
  | 'OTHER';

export type CampaignSignal = {
  id: string;
  name: string;
  kind: CampaignKind;
  /** ENABLED or PAUSED as Google reports it; anything else is OTHER. */
  status: 'ENABLED' | 'PAUSED' | 'OTHER';
  cost30: number;
  impressions30: number;
  clicks30: number;
  conversions30: number;
  value30: number;
};

/** Google's ConversionActionCategory folded into the groups the tree uses. */
export type ConversionGroup =
  | 'purchase'
  | 'lead_form'
  | 'call'
  | 'booking'
  | 'directions'
  | 'store_visit'
  | 'contact'
  | 'signup'
  | 'page_view'
  | 'other';

export type HourSignal = {
  /** 0 to 23 in the account's own time zone. */
  hour: number;
  cost: number;
  clicks: number;
  conversions: number;
  /** metrics.phone_calls (calls from call assets); 0 when the account has none. */
  phoneCalls: number;
};

export type ProductSignal = { id: string; title: string; cost30: number; conversions30: number; value30: number };

export type AccountSignals = {
  version: 1;
  /** ISO time the read finished. */
  readAt: string;
  /** 10 digits, no dashes. */
  customerId: string;
  currency: string;
  /** Every non-removed campaign with its last-30-days numbers. */
  campaigns: SignalRead<CampaignSignal[]>;
  /** Enabled conversion actions (same query the audit already runs on production). */
  enabledConversionActions: SignalRead<number>;
  /** Last 30 days, by segments.conversion_action_category. */
  conversionsByGroup: SignalRead<Array<{ group: ConversionGroup; conversions: number }>>;
  /** customer.auto_tagging_enabled. */
  autoTagging: SignalRead<boolean>;
  /** Hostnames of enabled ads' and asset groups' final URLs, most used first, at most 10. */
  landingHosts: SignalRead<string[]>;
  /** campaign.shopping_setting.merchant_id present on any non-removed campaign. */
  merchantCenterLinked: SignalRead<boolean>;
  /** Enabled call and location assets linked at account or campaign level. */
  assets: SignalRead<{ call: boolean; locations: number }>;
  /** Positive location targets on enabled campaigns, display names, at most 12. */
  targetedPlaces: SignalRead<string[]>;
  /** Active links to a manager account that is not one of ours (Modaafa's MCC and GOOGLE_ADS_MANAGER_IDS excluded). */
  externalManager: SignalRead<{ linked: boolean; managerIds: string[] }>;
  /** Distinct editors in change_event, last 14 days, who are not the connected email and not Google's own automation. */
  otherEditors14d: SignalRead<number>;
  /** Last 30 days by hour of day, summed over enabled campaigns. */
  hours: SignalRead<HourSignal[]>;
  /** Top 50 products by cost from shopping_performance_view, last 30 days. */
  products: SignalRead<ProductSignal[]>;
};

export type SignalKey = Exclude<keyof AccountSignals, 'version' | 'readAt' | 'customerId' | 'currency'>;

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------

/** First match wins, in this order: no_account, new, dormant, no_tracking, tracking_suspect, active. */
export type AccountState =
  | 'no_account'
  /** Linked, but zero non-removed campaigns, or zero cost and zero impressions in 30 days. */
  | 'new'
  /** Like new, but there are old paused campaigns. Same questions as new. */
  | 'dormant'
  /** Spends, and zero enabled conversion actions. No waste number is shown. */
  | 'no_tracking'
  /** Spends, has enabled actions, zero conversions in 30 days with at least TRACKING_SUSPECT_MIN_CLICKS clicks. */
  | 'tracking_suspect'
  | 'active';

export type BusinessKind = 'ecommerce' | 'clinic' | 'services' | 'local' | 'general';

export type StorePlatform = 'salla' | 'zid' | 'shopify';

export type ClinicSpecialty = 'dental' | 'derma' | 'general';

/** What the customer gets most from ads, read from conversions by group. */
export type DominantOutcome = 'purchases' | 'calls' | 'forms' | 'bookings' | 'visits' | 'unknown';

export type Scenario = {
  state: AccountState;
  /** «confirmed» only after the customer said so (manager answer agency or employee). */
  managed: 'confirmed' | 'suspected' | 'none';
  kind: BusinessKind;
  /** confident: top score >= 3 and leads the runner-up by >= 2, so the opener asks «صح؟». */
  kindConfidence: 'stated' | 'confident' | 'guess' | 'none';
  /** Kinds in score order, for ordering the type question when not confident. */
  kindRanking: BusinessKind[];
  platform: StorePlatform | null;
  specialty: ClinicSpecialty | null;
  outcome: DominantOutcome;
  /** Short ASCII codes saying what drove each choice, for tests and the operator page. */
  evidence: string[];
};

export type ClassifyInput = {
  signals: AccountSignals | null;
  linkedAccounts: number;
  /** The connect job ended with no_accounts or no_client_accounts. */
  connectNoAccount: boolean;
  /** Answers on record (ledger choice ids): has_account, type, manager, confirm. */
  answered: Partial<Record<string, string | null>>;
};

export const TRACKING_SUSPECT_MIN_CLICKS = 100;
export const KIND_CONFIDENT_SCORE = 3;
export const KIND_CONFIDENT_LEAD = 2;

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

/**
 * Keys the adaptive tree adds on top of the ten in questions.ts. Each answer is
 * stored exactly like the legacy ones: a `business_memory` fact with
 * data.setup_key, so a refresh knows what was answered without a migration.
 */
export const ADAPTIVE_KEYS = [
  /** The opener's «صح؟» (yes/no) over the guessed kind and outcome. */
  'confirm',
  /** «ما عندي حساب إعلانات» chosen before or after connecting. */
  'has_account',
  'focus_service',
  /** Store: the average order computed from the account, confirmed (same/less/more). */
  'aov_check',
  'margin',
  'push_products',
  'exclude_products',
  'call_hours',
  'whatsapp_booking',
  'deal_value',
  'close_rate',
  'peak_hours',
  'delivery_apps',
  'tracking_now',
] as const;
export type AdaptiveKey = (typeof ADAPTIVE_KEYS)[number];

export type AdaptiveAnswer = {
  key: AdaptiveKey;
  /** One option id from the key's catalog (lowercase ascii). */
  choice: string;
  /** Multi-select keys (push_products, peak_hours). */
  choices?: string[];
  /** Free text where a key allows it (focus_service «غير كذا», push_products typed names). */
  text?: string;
  /** confirm only: the kind and outcome the opener proposed, so a «yes» can be written as stated facts. */
  kind?: BusinessKind;
  outcome?: DominantOutcome;
};

export type AdaptiveOption = { id: string; label: string; hint?: string; icon?: string };

/** How the screen asks one question. `null` from the bank means «use the legacy copy and dock». */
export type AdaptiveQuestion = {
  key: string;
  text: string;
  why?: string;
  options: AdaptiveOption[];
  /** chips: multi-select pills with «تم»; tiles: one tap. */
  layout: 'tiles' | 'tiles2' | 'chips';
  /** Lets the customer type their own (with a placeholder) next to the options. */
  freeText?: { placeholder: string; maxLength: number } | null;
  /** The option id already on record, marked in edit mode. */
  current?: string | null;
};

export type QuestionContext = {
  scenario: Scenario;
  signals: AccountSignals | null;
  answered: Partial<Record<string, string | null>>;
  edit: boolean;
};

// ---------------------------------------------------------------------------
// What the screen shows around the questions
// ---------------------------------------------------------------------------

export type Opener = {
  /** «هلا سلطان، ربطت حسابك وقريته.» */
  greeting: string;
  /** The «اللي شفته» box: plain facts from the account, 1 to 4 rows. */
  seen: string[];
  /** The big line, e.g. «يعني عيادة أسنان في جدة، وشغلك على الاتصالات.» */
  headline: string;
  /** The small line under it, e.g. «صح كذا؟». */
  ask: string;
  /** Kind and outcome to send back with a «yes». */
  proposal: { kind: BusinessKind; outcome: DominantOutcome } | null;
};

export type UnderstoodRow = {
  label: string;
  value: string;
  /** account: read from Google; confirmed: read and then confirmed; you: the customer's own answer. */
  source: 'account' | 'confirmed' | 'you';
};

/** A first decision the tree finds by rules (not from the audit). Shown first and open on «خطتك جاهزة». */
export type ScenarioDecision = {
  id: 'call_hours' | 'idle_products' | 'tracking_setup';
  title: string;
  /** The numbers behind it, from the account. */
  reason: string;
  /** «ليش أول شي»: tied to what the customer said. */
  why: string;
  /** Manual steps; these decisions are never executed by the platform. */
  steps: string[];
  amount: number | null;
  currency: string;
};

export type FirstCampaignPlan = {
  title: string;
  /** e.g. «حملة بحث على التقويم والزراعة في جدة». */
  campaign: string;
  budgetLine: string;
  items: Array<{ label: string; detail: string }>;
  /** What happens next: trial for «new», WhatsApp help for «no_account». */
  next: 'trial' | 'open_account';
};

export type EndingKind = 'plan' | 'first_campaign' | 'agency' | 'tracking';
