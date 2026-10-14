/**
 * Shared vocabulary for the email lifecycle system.
 *
 * Every module in lib/lifecycle, lib/messaging and the funnel report imports
 * from here. Read docs/email-lifecycle/CONTRACT.md before changing a name:
 * template keys are stored in message_log and categories in users.email_prefs,
 * so a rename silently orphans rows.
 */

/** What a user can switch off. `transactional` cannot be switched off. */
export const EMAIL_CATEGORIES = [
  'transactional',
  'onboarding',
  'lifecycle',
  'weekly_report',
  'product_news',
] as const;
export type EmailCategory = (typeof EMAIL_CATEGORIES)[number];

/** Categories shown on the preferences page, in display order. */
export const OPTIONAL_CATEGORIES = ['lifecycle', 'weekly_report', 'product_news'] as const satisfies readonly EmailCategory[];
export type OptionalCategory = (typeof OPTIONAL_CATEGORIES)[number];

/**
 * Copy keys. One entry per text in lib/lifecycle/copy.ts. The message_log
 * template key is the copy key, except for recurring and broadcast mail:
 *   weekly_report      -> weekly_report_<YYYY>-W<ww>
 *   broadcast_<id>     -> broadcast_<id>
 */
export const COPY_KEYS = [
  // onboarding (sent immediately after /register completes)
  'welcome_ads_connect',
  // journey: registered, never connected
  'registered_1d',
  'registered_3d',
  'registered_7d',
  // journey: connected, plan not seen
  'connected_3h',
  'connected_1d',
  // journey: plan seen, no trial
  'plan_ready_1d',
  'plan_ready_3d',
  'plan_ready_7d',
  // journey: trialing
  'trial_d1',
  'trial_d4',
  'trial_d9',
  // journey: trial ended without a payment
  'trial_lapsed_2d',
  'trial_lapsed_14d',
  // journey: paid at least once, then cancelled
  'canceled_1d',
  'canceled_30d',
  // journey: payment failing
  'past_due_3d',
  // recurring: trialing + active subscribers
  'weekly_report',
  // transactional, sent from the Stripe webhook (not by the journey runner)
  'tx_subscription_welcome',
  'tx_trial_ending',
  'tx_payment_failed',
  // broadcasts (config/email-broadcasts.ts)
  'broadcast_chat_relaunch',
] as const;
export type CopyKey = (typeof COPY_KEYS)[number];

/** Data that can appear inside an email. Every field may be missing. */
export type PlanFacts = {
  /** Decisions in the plan the user saw (open + locked). */
  decisionsTotal: number;
  /** Decisions hidden behind the subscription lock. */
  lockedCount: number;
  /** Title of the one decision shown unlocked, as the plan renders it. */
  firstDecisionTitle: string | null;
  /** Estimated monthly waste in the account currency, from the plan. null = no estimate. */
  wasteEstimate: number | null;
  currency: string;
};

export type TrialFacts = {
  startedAt: string;
  endsAt: string | null;
  /** Whole days until endsAt, never negative. null when endsAt is unknown. */
  daysLeft: number | null;
  /** Recommendations the user approved since the trial started. */
  approvedCount: number;
  /** Recommendations waiting for the user's decision right now. */
  pendingCount: number;
};

export type WeeklyFacts = {
  periodStart: string;
  periodEnd: string;
  currency: string;
  spend: number | null;
  conversions: number | null;
  costPerConversion: number | null;
  prevSpend: number | null;
  prevConversions: number | null;
  /** Short lines from the stored weekly report narrative, in order. Max 3. */
  highlights: string[];
  /** Recommendations waiting for the user's decision right now. */
  pendingCount: number;
};

export type BillingFacts = {
  planName: string | null;
  trialEndsAt: string | null;
};

export type EmailFacts = {
  firstName: string | null;
  /** Business name from the onboarding answers or the Google Ads account name. */
  businessName: string | null;
  plan: PlanFacts | null;
  trial: TrialFacts | null;
  weekly: WeeklyFacts | null;
  billing: BillingFacts | null;
};

export type FactNeed = 'plan' | 'trial' | 'weekly' | 'billing';

export const EMPTY_FACTS: EmailFacts = {
  firstName: null,
  businessName: null,
  plan: null,
  trial: null,
  weekly: null,
  billing: null,
};

/** Content blocks the renderer knows how to draw. Text is plain, never HTML. */
export type Block =
  | { type: 'p'; text: string }
  | { type: 'stat'; label: string; value: string; note?: string }
  | { type: 'list'; items: string[] }
  | { type: 'note'; text: string };

export type BuiltEmail = {
  subject: string;
  /** Inbox preview line, under 90 characters. */
  preheader: string;
  /** Everything after the greeting. The renderer adds "هلا {name}،" itself. */
  blocks: Block[];
  /** Internal app path only (starts with "/"). The renderer turns it into a tracked link. */
  cta?: { label: string; path: string };
  /** Line under the signature. */
  ps?: string;
  signer: 'team' | 'ayman';
};

export type EmailCopy = {
  key: CopyKey;
  category: EmailCategory;
  /** Flip only after Ayman has read the text. Unapproved copy is never sent by the runner. */
  approved: boolean;
  /** Facts that must be present. If one is null the send is skipped (reason missing_facts). */
  requires?: FactNeed[];
  /** Return null to skip this user (for example the facts make the message pointless). */
  build: (facts: EmailFacts) => BuiltEmail | null;
};

/** What lib/messaging/render.ts produces. */
export type RenderedMessage = {
  subject: string;
  html: string;
  text: string;
  headers: Record<string, string>;
  tags: Array<{ name: string; value: string }>;
};

export type RenderInput = {
  copy: EmailCopy;
  /** message_log template key (equals copy.key except weekly/broadcast). */
  templateKey: string;
  user: { id: string; email: string; name?: string | null };
  facts: EmailFacts;
};

export type JourneyId =
  | 'registered'
  | 'connected'
  | 'plan_ready'
  | 'trial'
  | 'trial_lapsed'
  | 'canceled'
  | 'past_due';
