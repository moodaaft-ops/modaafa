/**
 * Pure computations behind the operations center (مركز التشغيل).
 *
 * Everything here takes plain rows and a clock and returns plain data, so the
 * rules that decide "who needs Ayman today" and "where people drop out" are
 * tested without Supabase (tests/operator-insights.test.ts). Loading lives in
 * operator-data.ts; rendering lives in app/(dashboard)/operations.
 */

import { normalizeOverrideRows, summarizeOverrides, type LiveAccessOverrides } from '@/lib/billing/access-overrides';
import { isSubscriptionEntitled } from '@/lib/billing/entitlements';

export const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Input rows (the columns operator-data.ts selects)
// ---------------------------------------------------------------------------

export type Row = Record<string, any>;

export type OperatorDataset = {
  users: Row[];
  /** auth.users facts keyed by user id: email_confirmed_at, last_sign_in_at. */
  auth: Record<string, { email_confirmed_at: string | null; last_sign_in_at: string | null }>;
  businesses: Row[];
  accounts: Row[];
  subscriptions: Row[];
  audits: Row[];
  overrides: Row[];
  invoices: Row[];
  /** Usage events of the last 30 days. */
  usage: Row[];
  /** Recommendations created or touched in the last 30 days. */
  recommendations: Row[];
  /** ai_actions of the last 30 days. */
  actions: Row[];
  /** job_runs of the last 7 days. */
  jobs: Row[];
  /** Failed webhook events of the last 7 days. */
  webhooks: Row[];
  /** Latest operator audit rows. */
  auditLog: Row[];
  /** Operator emails, excluded from customer counts. */
  operatorEmails: string[];
  /** Monthly price per plan, SAR. */
  monthlyPrices: Record<'starter' | 'growth' | 'pro', number>;
  /** Tables that could not be read (for example before a migration ran). */
  unavailable: string[];
};

// ---------------------------------------------------------------------------
// Customer profiles
// ---------------------------------------------------------------------------

export const STAGES = ['signed_up', 'confirmed', 'business', 'connected', 'audited', 'trial', 'paying'] as const;
export type CustomerStage = (typeof STAGES)[number];

export const STAGE_LABELS: Record<CustomerStage, string> = {
  signed_up: 'سجّل',
  confirmed: 'دخل المنصة',
  business: 'عبّى النشاط',
  connected: 'ربط حساب إعلانات',
  audited: 'سوّى فحص',
  trial: 'بدأ تجربة',
  paying: 'دفع',
};

/** What the person still has to do to move on, shown beside a stuck stage. */
export const STAGE_NEXT_STEP: Record<CustomerStage, string> = {
  signed_up: 'ما فتح رابط الإيميل',
  confirmed: 'ما عبّى بيانات النشاط',
  business: 'ما ربط حساب إعلانات قوقل',
  connected: 'ما سوّى أول فحص',
  audited: 'ما بدأ التجربة',
  trial: 'ما وصل أول دفعة',
  paying: 'عميل دافع',
};

export type AccessState =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'trial_ended'
  | 'comp'
  | 'suspended'
  | 'none';

export const ACCESS_LABELS: Record<AccessState, string> = {
  trialing: 'تجربة',
  active: 'مشترك',
  past_due: 'دفعته فشلت',
  canceled: 'ألغى',
  trial_ended: 'انتهت تجربته',
  comp: 'خطة مجانية',
  suspended: 'موقوف',
  none: 'بدون اشتراك',
};

export type CustomerProfile = {
  id: string;
  email: string;
  name: string | null;
  phone: string | null;
  businessName: string | null;
  sector: string | null;
  website: string | null;
  createdAt: string | null;
  confirmedAt: string | null;
  lastSeenAt: string | null;
  businessCreatedAt: string | null;
  milestones: Record<CustomerStage, boolean>;
  stage: CustomerStage;
  accounts: { total: number; active: number; googleDisabled: number; revoked: number };
  firstLinkedAt: string | null;
  lastSyncedAt: string | null;
  audits: number;
  lastAuditAt: string | null;
  subscription: {
    plan: string | null;
    status: string | null;
    billingPeriod: string | null;
    trialEndsAt: string | null;
    currentPeriodEnd: string | null;
    createdAt: string | null;
    hasStripe: boolean;
  } | null;
  /** What the customer can use right now (entitlements view, overrides applied). */
  access: AccessState;
  /** The live Stripe state, independent of overrides: Stripe bills by this. */
  stripeStatus: 'trialing' | 'active' | 'past_due' | null;
  overrides: LiveAccessOverrides;
  /** Paid invoices, ever. */
  paidInvoices: number;
  paidTotal: number;
  usage7d: number;
  usage30d: number;
  recsApplied30d: number;
  recsFailed7d: number;
  recsStuck: number;
  /** Current monthly recurring revenue from this customer, SAR. */
  mrr: number;
  /** What this trial is worth per month if it converts. */
  trialValue: number;
  isOperator: boolean;
};

const ms = (value: unknown) => {
  if (!value) return NaN;
  const t = new Date(value as string).getTime();
  return Number.isFinite(t) ? t : NaN;
};

const maxIso = (...values: Array<string | null | undefined>) => {
  let best: string | null = null;
  let bestMs = -Infinity;
  for (const value of values) {
    const t = ms(value);
    if (Number.isFinite(t) && t > bestMs) {
      bestMs = t;
      best = value as string;
    }
  }
  return best;
};

const minIso = (...values: Array<string | null | undefined>) => {
  let best: string | null = null;
  let bestMs = Infinity;
  for (const value of values) {
    const t = ms(value);
    if (Number.isFinite(t) && t < bestMs) {
      bestMs = t;
      best = value as string;
    }
  }
  return best;
};

/** Google says the ad account is not usable (cancelled, suspended, closed, not enabled). */
export function isGoogleDisabled(account: Row) {
  if (account.status === 'paused') return true;
  const status = typeof account.google_status === 'string' ? account.google_status.toUpperCase() : null;
  return Boolean(status && status !== 'ENABLED' && status !== 'UNKNOWN' && status !== 'UNSPECIFIED');
}

const LIVE_ORDER: Record<string, number> = { active: 5, past_due: 4, trialing: 3, paused: 2, canceled: 1 };
const PLAN_RANK = { starter: 1, growth: 2, pro: 3 } as const;

function pickSubscription(rows: Row[], now: number) {
  if (rows.length === 0) return null;
  return [...rows].sort((a, b) => {
    const aLive = isSubscriptionEntitled(a, now) ? 1 : 0;
    const bLive = isSubscriptionEntitled(b, now) ? 1 : 0;
    if (aLive !== bLive) return bLive - aLive;
    const order = (LIVE_ORDER[b.status] ?? 0) - (LIVE_ORDER[a.status] ?? 0);
    if (order !== 0) return order;
    return ms(b.created_at) - ms(a.created_at);
  })[0];
}

export function monthlyValueOf(
  subscription: { plan?: string | null; billing_period?: string | null } | null | undefined,
  prices: OperatorDataset['monthlyPrices']
) {
  const plan = subscription?.plan as keyof typeof prices | undefined;
  if (!plan || !(plan in prices)) return 0;
  // Yearly plans bill twelve months at a discount; the monthly list price is
  // the conservative stand-in until the actual yearly amount is known.
  return prices[plan];
}

function groupBy<T extends Row>(rows: T[], key: (row: T) => string | null | undefined) {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    if (!k) continue;
    const list = map.get(k);
    if (list) list.push(row);
    else map.set(k, [row]);
  }
  return map;
}

export function buildCustomerProfiles(data: OperatorDataset, now = Date.now()): CustomerProfile[] {
  const operatorEmails = new Set(data.operatorEmails.map((email) => email.toLowerCase()));
  const businessByUser = new Map<string, Row>();
  const userByBusiness = new Map<string, string>();
  for (const business of data.businesses) {
    if (!business.user_id) continue;
    businessByUser.set(business.user_id, business);
    userByBusiness.set(business.id, business.user_id);
  }

  const accountsByUser = groupBy(
    data.accounts.filter((account) => !account.is_manager),
    (account) => userByBusiness.get(account.business_id)
  );
  const userByAccount = new Map<string, string>();
  for (const account of data.accounts) {
    const userId = userByBusiness.get(account.business_id);
    if (userId) userByAccount.set(account.id, userId);
  }

  const auditsByUser = groupBy(data.audits, (audit) => userByAccount.get(audit.account_id));
  const subsByUser = groupBy(data.subscriptions, (sub) => sub.user_id);
  const overridesByUser = groupBy(normalizeOverrideRows(data.overrides) as Row[], (row) => row.user_id);
  const invoicesByUser = groupBy(data.invoices, (invoice) => invoice.user_id);
  const usageByUser = groupBy(data.usage, (event) => event.user_id);
  const recsByUser = groupBy(data.recommendations, (rec) => userByAccount.get(rec.account_id));

  return data.users.map((user) => {
    const auth = data.auth[user.id] ?? { email_confirmed_at: null, last_sign_in_at: null };
    const business = businessByUser.get(user.id) ?? null;
    const accounts = accountsByUser.get(user.id) ?? [];
    const audits = auditsByUser.get(user.id) ?? [];
    const subs = subsByUser.get(user.id) ?? [];
    const invoices = invoicesByUser.get(user.id) ?? [];
    const usage = usageByUser.get(user.id) ?? [];
    const recs = recsByUser.get(user.id) ?? [];
    const overrides = summarizeOverrides(overridesByUser.get(user.id) ?? [], now);

    const paid = invoices.filter((invoice) => invoice.status === 'paid');
    const sub = pickSubscription(subs, now);
    const subLive = sub ? isSubscriptionEntitled(sub, now) : false;

    const lastUsage = maxIso(...usage.map((event) => event.created_at));
    const lastSeenAt = maxIso(auth.last_sign_in_at, user.last_login_at, lastUsage);
    const confirmedAt = auth.email_confirmed_at ?? (auth.last_sign_in_at ? auth.last_sign_in_at : null);

    const activeAccounts = accounts.filter((account) => account.status === 'active' && !isGoogleDisabled(account));
    const milestones: Record<CustomerStage, boolean> = {
      signed_up: true,
      confirmed: Boolean(confirmedAt || user.last_login_at),
      business: Boolean(business),
      connected: accounts.length > 0,
      audited: audits.length > 0,
      trial: subs.length > 0,
      paying: paid.length > 0 || subs.some((row) => row.status === 'active'),
    };
    // Someone who got further cannot have skipped confirming their email.
    if (milestones.business || milestones.connected) milestones.confirmed = true;

    let stage: CustomerStage = 'signed_up';
    for (const key of STAGES) if (milestones[key]) stage = key;

    const stripeStatus =
      sub && subLive && (sub.status === 'active' || sub.status === 'past_due' || sub.status === 'trialing')
        ? (sub.status as 'active' | 'past_due' | 'trialing')
        : null;
    // Same rule as entitlements.applyAccessOverrides: a free plan shows when it
    // is higher than whatever Stripe currently grants.
    const liveRank = stripeStatus ? PLAN_RANK[sub?.plan as keyof typeof PLAN_RANK] ?? 0 : 0;
    const grantWins = Boolean(overrides.grant && PLAN_RANK[overrides.grant.plan] > liveRank);

    let access: AccessState = 'none';
    if (overrides.suspended) access = 'suspended';
    else if (grantWins) access = 'comp';
    else if (stripeStatus) access = stripeStatus;
    else if (sub?.status === 'past_due') access = 'past_due';
    else if (sub?.status === 'trialing') access = 'trial_ended';
    else if (sub?.status === 'canceled') access = 'canceled';

    const sevenDaysAgo = now - 7 * DAY_MS;
    const recsStuck = recs.filter(
      (rec) => rec.status === 'executing' && now - ms(rec.execution_started_at ?? rec.created_at) > 30 * 60 * 1000
    ).length;

    return {
      id: user.id,
      email: user.email ?? '',
      name: user.name ?? null,
      phone: user.phone ?? null,
      businessName: business?.name ?? null,
      sector: business?.sector ?? null,
      website: business?.website ?? null,
      createdAt: user.created_at ?? null,
      confirmedAt,
      lastSeenAt,
      businessCreatedAt: business?.created_at ?? null,
      milestones,
      stage,
      accounts: {
        total: accounts.length,
        active: activeAccounts.length,
        googleDisabled: accounts.filter(isGoogleDisabled).length,
        revoked: accounts.filter((account) => account.status === 'revoked').length,
      },
      firstLinkedAt: minIso(...accounts.map((account) => account.linked_at)),
      lastSyncedAt: maxIso(...accounts.map((account) => account.last_synced_at)),
      audits: audits.length,
      lastAuditAt: maxIso(...audits.map((audit) => audit.ran_at)),
      subscription: sub
        ? {
            plan: sub.plan ?? null,
            status: sub.status ?? null,
            billingPeriod: sub.billing_period ?? null,
            trialEndsAt: sub.trial_ends_at ?? null,
            currentPeriodEnd: sub.current_period_end ?? null,
            createdAt: sub.created_at ?? null,
            hasStripe: Boolean(sub.stripe_subscription_id),
          }
        : null,
      access,
      stripeStatus,
      overrides,
      paidInvoices: paid.length,
      paidTotal: paid.reduce((sum, invoice) => sum + Number(invoice.amount_sar ?? 0), 0),
      usage7d: usage.filter((event) => ms(event.created_at) >= sevenDaysAgo).length,
      usage30d: usage.length,
      recsApplied30d: recs.filter((rec) => rec.status === 'applied').length,
      recsFailed7d: recs.filter((rec) => rec.status === 'failed' && ms(rec.applied_at ?? rec.created_at) >= sevenDaysAgo)
        .length,
      recsStuck,
      // Money follows Stripe, not access: a suspended or comp customer whose
      // Stripe subscription is live is still billed.
      mrr: stripeStatus === 'active' || stripeStatus === 'past_due' ? monthlyValueOf(sub, data.monthlyPrices) : 0,
      trialValue: stripeStatus === 'trialing' ? monthlyValueOf(sub, data.monthlyPrices) : 0,
      isOperator: operatorEmails.has(String(user.email ?? '').toLowerCase()),
    };
  });
}

// ---------------------------------------------------------------------------
// Funnel
// ---------------------------------------------------------------------------

export type FunnelRange = '7d' | '30d' | '90d' | 'all';
export const FUNNEL_RANGES: Record<FunnelRange, { label: string; days: number | null }> = {
  '7d': { label: '7 أيام', days: 7 },
  '30d': { label: '30 يوم', days: 30 },
  '90d': { label: '90 يوم', days: 90 },
  all: { label: 'من البداية', days: null },
};

export function parseFunnelRange(value: unknown): FunnelRange {
  return value === '7d' || value === '90d' || value === 'all' ? value : '30d';
}

export type FunnelStep = {
  stage: CustomerStage;
  label: string;
  reached: number;
  /** Reached this step out of those who reached the previous one (0..1). */
  fromPrevious: number | null;
  /** Reached the previous step but not this one. */
  dropped: number;
  /** People whose furthest step is exactly this one. */
  stuckHere: number;
};

/** Cohort funnel: people who signed up inside the range, and how far each got. */
export function computeFunnel(profiles: CustomerProfile[], range: FunnelRange, now = Date.now()): FunnelStep[] {
  const days = FUNNEL_RANGES[range].days;
  const cohort = profiles.filter(
    (profile) => !profile.isOperator && (days === null || ms(profile.createdAt) >= now - days * DAY_MS)
  );
  return STAGES.map((stage, index) => {
    const reached = cohort.filter((profile) => profile.milestones[stage]).length;
    const previous = index === 0 ? null : cohort.filter((profile) => profile.milestones[STAGES[index - 1]]).length;
    return {
      stage,
      label: STAGE_LABELS[stage],
      reached,
      fromPrevious: previous === null ? null : previous === 0 ? 0 : Math.min(1, reached / previous),
      dropped: previous === null ? 0 : Math.max(0, previous - reached),
      stuckHere: cohort.filter((profile) => profile.stage === stage).length,
    };
  });
}

/** The step that loses the most people, by count. Null when nothing is lost. */
export function biggestLeak(steps: FunnelStep[]) {
  let worst: FunnelStep | null = null;
  // The last step (paying) is left out: before trials reach their first
  // charge it loses everyone by definition, which is not a leak.
  for (const step of steps.slice(1, steps.length - 1)) {
    if (step.dropped > 0 && (!worst || step.dropped > worst.dropped)) worst = step;
  }
  return worst;
}

// ---------------------------------------------------------------------------
// Pulse: this week against the week before
// ---------------------------------------------------------------------------

export type PulseMetric = { key: string; label: string; current: number; previous: number; hint: string };

export function computePulse(profiles: CustomerProfile[], data: OperatorDataset, now = Date.now()): PulseMetric[] {
  const customers = profiles.filter((profile) => !profile.isOperator);
  const ids = new Set(customers.map((profile) => profile.id));
  const inWindow = (value: unknown, weeksBack: number) => {
    const t = ms(value);
    return Number.isFinite(t) && t < now - weeksBack * 7 * DAY_MS && t >= now - (weeksBack + 1) * 7 * DAY_MS;
  };

  const userByBusiness = new Map<string, string>();
  for (const business of data.businesses) userByBusiness.set(business.id, business.user_id);
  const firstLinkByUser = new Map<string, string>();
  for (const account of data.accounts) {
    if (account.is_manager) continue;
    const userId = userByBusiness.get(account.business_id);
    if (!userId || !ids.has(userId)) continue;
    const prev = firstLinkByUser.get(userId);
    if (!prev || ms(account.linked_at) < ms(prev)) firstLinkByUser.set(userId, account.linked_at);
  }
  const firstSubByUser = new Map<string, string>();
  for (const sub of data.subscriptions) {
    if (!ids.has(sub.user_id)) continue;
    const prev = firstSubByUser.get(sub.user_id);
    if (!prev || ms(sub.created_at) < ms(prev)) firstSubByUser.set(sub.user_id, sub.created_at);
  }
  const activeUsers = (weeksBack: number) => {
    const set = new Set<string>();
    for (const event of data.usage) if (ids.has(event.user_id) && inWindow(event.created_at, weeksBack)) set.add(event.user_id);
    return set.size;
  };
  const count = (values: Iterable<unknown>, weeksBack: number) => {
    let n = 0;
    for (const value of values) if (inWindow(value, weeksBack)) n += 1;
    return n;
  };

  return [
    {
      key: 'signups',
      label: 'تسجيلات جديدة',
      current: count(customers.map((p) => p.createdAt), 0),
      previous: count(customers.map((p) => p.createdAt), 1),
      hint: 'آخر 7 أيام',
    },
    {
      key: 'connected',
      label: 'ربطوا حساب إعلانات',
      current: count(firstLinkByUser.values(), 0),
      previous: count(firstLinkByUser.values(), 1),
      hint: 'أول ربط، آخر 7 أيام',
    },
    {
      key: 'trials',
      label: 'بدأوا تجربة',
      current: count(firstSubByUser.values(), 0),
      previous: count(firstSubByUser.values(), 1),
      hint: 'آخر 7 أيام',
    },
    {
      key: 'active',
      label: 'استخدموا المنصة',
      current: activeUsers(0),
      previous: activeUsers(1),
      hint: 'فحص أو مساعد أو تنفيذ، آخر 7 أيام',
    },
  ];
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

export type RevenueSummary = {
  mrr: number;
  payingCustomers: number;
  pastDueCustomers: number;
  pastDueValue: number;
  trialing: number;
  trialPipeline: number;
  compCustomers: number;
  collectedTotal: number;
  /** Trials converting in the next 14 days, one entry per day. */
  upcoming: Array<{ date: string; count: number; value: number; atRisk: number; customers: Array<{ id: string; email: string; atRisk: boolean }> }>;
};

/** Calendar day in Riyadh (UTC+3), as YYYY-MM-DD. */
export function riyadhDay(value: number | string | Date) {
  const t = typeof value === 'number' ? value : new Date(value).getTime();
  return new Date(t + 3 * HOUR_MS).toISOString().slice(0, 10);
}

export function computeRevenue(profiles: CustomerProfile[], now = Date.now()): RevenueSummary {
  const customers = profiles.filter((profile) => !profile.isOperator);
  const days: RevenueSummary['upcoming'] = [];
  const index = new Map<string, RevenueSummary['upcoming'][number]>();
  for (let i = 0; i < 14; i += 1) {
    const date = riyadhDay(now + i * DAY_MS);
    const entry = { date, count: 0, value: 0, atRisk: 0, customers: [] as Array<{ id: string; email: string; atRisk: boolean }> };
    days.push(entry);
    index.set(date, entry);
  }
  for (const profile of customers) {
    if (profile.stripeStatus !== 'trialing' || !profile.subscription?.trialEndsAt) continue;
    const entry = index.get(riyadhDay(profile.subscription.trialEndsAt));
    if (!entry) continue;
    const atRisk = profile.accounts.active === 0 || profile.audits === 0;
    entry.count += 1;
    entry.value += profile.trialValue;
    if (atRisk) entry.atRisk += 1;
    entry.customers.push({ id: profile.id, email: profile.email, atRisk });
  }

  const paying = customers.filter((profile) => profile.stripeStatus === 'active');
  const pastDue = customers.filter((profile) => profile.stripeStatus === 'past_due');
  const trialing = customers.filter((profile) => profile.stripeStatus === 'trialing');
  return {
    mrr: customers.reduce((sum, profile) => sum + profile.mrr, 0),
    payingCustomers: paying.length,
    pastDueCustomers: pastDue.length,
    pastDueValue: pastDue.reduce((sum, profile) => sum + profile.mrr, 0),
    trialing: trialing.length,
    trialPipeline: trialing.reduce((sum, profile) => sum + profile.trialValue, 0),
    compCustomers: customers.filter((profile) => profile.access === 'comp').length,
    collectedTotal: customers.reduce((sum, profile) => sum + profile.paidTotal, 0),
    upcoming: days,
  };
}

// ---------------------------------------------------------------------------
// Who needs Ayman today
// ---------------------------------------------------------------------------

export type AttentionReason =
  | 'payment_failed'
  | 'trial_ending_no_account'
  | 'trial_ending_unused'
  | 'execution_failed'
  | 'google_disabled'
  | 'never_logged_in'
  | 'no_ads_account'
  | 'connected_no_audit'
  | 'audited_no_trial'
  | 'went_quiet';

export type AttentionItem = {
  profile: CustomerProfile;
  reason: AttentionReason;
  severity: 'critical' | 'high' | 'medium';
  title: string;
  detail: string;
  /** Other reasons this person also matched, by title. */
  more: string[];
  whatsappText: string;
};

const SEVERITY_RANK = { critical: 3, high: 2, medium: 1 } as const;

function relativeDays(target: number, now: number) {
  const days = Math.round((target - now) / DAY_MS);
  if (days <= 0) {
    const hours = Math.max(1, Math.round((target - now) / HOUR_MS));
    return hours <= 1 ? 'خلال ساعة' : `خلال ${hours} ساعة`;
  }
  if (days === 1) return 'بكرة';
  if (days === 2) return 'بعد يومين';
  return `بعد ${days} أيام`;
}

function agoDays(value: string | null, now: number) {
  const t = ms(value);
  if (!Number.isFinite(t)) return '';
  const days = Math.floor((now - t) / DAY_MS);
  if (days <= 0) return 'اليوم';
  if (days === 1) return 'أمس';
  if (days === 2) return 'من يومين';
  if (days <= 10) return `من ${days} أيام`;
  return `من ${days} يوم`;
}

const WHATSAPP_TEXT: Record<AttentionReason, string> = {
  payment_failed: 'هلا معك ايمن من مضاعف الدفع ما مشى على بطاقتك تبي رابط تحدّث منه البطاقة',
  trial_ending_no_account: 'هلا معك ايمن من مضاعف تجربتك قربت تخلص وما ربطت حساب اعلانات قوقل تبي اساعدك تربطه قبل لا تنتهي',
  trial_ending_unused: 'هلا معك ايمن من مضاعف تجربتك قربت تخلص وحبيت اتأكد انك شفت خطة حسابك وش ناقصك',
  execution_failed: 'هلا معك ايمن من مضاعف لاحظت توصية ما تنفذت على حسابك قاعد اشيك عليها وارجع لك',
  google_disabled: 'هلا معك ايمن من مضاعف حساب اعلاناتك في قوقل طالع موقف تبي اساعدك نشوف السبب',
  never_logged_in: 'هلا معك ايمن من مضاعف شفتك سجلت بس ما دخلت المنصة وصلك رابط الدخول على الايميل؟',
  no_ads_account: 'هلا معك ايمن من مضاعف شفتك سجلت وما ربطت حساب اعلانات قوقل تبي نفتح لك حساب مجانا',
  connected_no_audit: 'هلا معك ايمن من مضاعف شفتك ربطت حسابك بس ما سويت اول فحص تبي اساعدك فيه',
  audited_no_trial: 'هلا معك ايمن من مضاعف شفت فحص حسابك وش رايك فيه؟ عندك سؤال قبل تبدا التجربة',
  went_quiet: 'هلا معك ايمن من مضاعف حبيت اتطمن عليك وش وضع حسابك',
};

export function buildAttentionQueue(profiles: CustomerProfile[], now = Date.now()) {
  const items: AttentionItem[] = [];
  for (const profile of profiles) {
    if (profile.isOperator || profile.access === 'suspended') continue;
    const matches: Array<Omit<AttentionItem, 'profile' | 'more' | 'whatsappText'>> = [];
    const created = ms(profile.createdAt);
    const age = Number.isFinite(created) ? now - created : Infinity;
    const recent = age <= 30 * DAY_MS;
    const trialEnd = ms(profile.subscription?.trialEndsAt);
    const endsSoon = profile.stripeStatus === 'trialing' && Number.isFinite(trialEnd) && trialEnd - now <= 3 * DAY_MS;

    if (profile.stripeStatus === 'past_due' || profile.access === 'past_due') {
      matches.push({
        reason: 'payment_failed',
        severity: 'critical',
        title: 'دفعته فشلت',
        detail: 'Stripe يحاول يسحب ولا مشى، والوصول ينقطع بعد أيام السماح.',
      });
    }
    if (endsSoon && profile.accounts.active === 0) {
      matches.push({
        reason: 'trial_ending_no_account',
        severity: 'critical',
        title: `تجربته تنتهي ${relativeDays(trialEnd, now)} وما عنده حساب إعلانات شغال`,
        detail: 'لو انخصم بدون ما شاف قيمة، غالباً يطلب استرجاع.',
      });
    } else if (endsSoon && profile.audits === 0 && profile.usage7d === 0) {
      matches.push({
        reason: 'trial_ending_unused',
        severity: 'high',
        title: `تجربته تنتهي ${relativeDays(trialEnd, now)} وما استخدم المنصة`,
        detail: 'لا فحص ولا مساعد ولا تنفيذ خلال التجربة.',
      });
    }
    if (profile.recsFailed7d > 0 || profile.recsStuck > 0) {
      const parts = [];
      if (profile.recsFailed7d > 0) parts.push(`${profile.recsFailed7d} فشل تنفيذها هالأسبوع`);
      if (profile.recsStuck > 0) parts.push(`${profile.recsStuck} عالقة على «قيد التنفيذ»`);
      matches.push({
        reason: 'execution_failed',
        severity: 'high',
        title: 'توصيات ما تنفذت على حسابه',
        detail: parts.join('، '),
      });
    }
    if (profile.accounts.googleDisabled > 0 && profile.accounts.active === 0) {
      matches.push({
        reason: 'google_disabled',
        severity: 'high',
        title: 'قوقل موقف حسابه الإعلاني',
        detail: 'المزامنة والمحسّن واقفين على حسابه لين يرجع الحساب عند قوقل.',
      });
    }
    if (!profile.milestones.confirmed && age > DAY_MS && recent) {
      matches.push({
        reason: 'never_logged_in',
        severity: 'high',
        title: `سجّل ${agoDays(profile.createdAt, now)} وما دخل ولا مرة`,
        detail: 'غالباً رابط الإيميل ما وصله أو انتهت صلاحيته.',
      });
    }
    if (profile.milestones.business && !profile.milestones.connected && recent) {
      const since = ms(profile.businessCreatedAt ?? profile.createdAt);
      if (!Number.isFinite(since) || now - since > DAY_MS) {
        matches.push({
          reason: 'no_ads_account',
          severity: 'medium',
          title: 'عبّى نشاطه وما ربط حساب إعلانات',
          detail: 'غالباً ما عنده حساب إعلانات قوقل. اعرض عليه نفتح له واحد مجاناً.',
        });
      }
    }
    if (profile.milestones.connected && !profile.milestones.audited && recent) {
      const linked = ms(profile.firstLinkedAt);
      if (Number.isFinite(linked) && now - linked > DAY_MS) {
        matches.push({
          reason: 'connected_no_audit',
          severity: 'medium',
          title: 'ربط حسابه وما سوّى أول فحص',
          detail: `الربط ${agoDays(profile.firstLinkedAt, now)}.`,
        });
      }
    }
    if (profile.milestones.audited && !profile.milestones.trial && recent) {
      const audited = ms(profile.lastAuditAt);
      if (Number.isFinite(audited) && now - audited > 2 * DAY_MS) {
        matches.push({
          reason: 'audited_no_trial',
          severity: 'medium',
          title: 'شاف الفحص وما بدأ التجربة',
          detail: `آخر فحص ${agoDays(profile.lastAuditAt, now)}.`,
        });
      }
    }
    if ((profile.access === 'trialing' || profile.access === 'active' || profile.access === 'comp') && !endsSoon) {
      const seen = ms(profile.lastSeenAt);
      if (!Number.isFinite(seen) || now - seen > 7 * DAY_MS) {
        matches.push({
          reason: 'went_quiet',
          severity: 'medium',
          title:
            profile.access === 'active'
              ? 'مشترك وما رجع من أسبوع'
              : profile.access === 'comp'
                ? 'عنده خطة مجانية وما رجع من أسبوع'
                : 'في التجربة وما رجع من أسبوع',
          detail: profile.lastSeenAt ? `آخر نشاط ${agoDays(profile.lastSeenAt, now)}.` : 'ما له نشاط مسجل.',
        });
      }
    }

    if (matches.length === 0) continue;
    matches.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
    const [top, ...rest] = matches;
    items.push({ profile, ...top, more: rest.map((match) => match.title), whatsappText: WHATSAPP_TEXT[top.reason] });
  }

  return items.sort((a, b) => {
    const severity = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (severity !== 0) return severity;
    // Inside a severity: the one with money on the line first, then the newest signup.
    const value = (b.profile.trialValue + b.profile.mrr) - (a.profile.trialValue + a.profile.mrr);
    if (value !== 0) return value;
    return ms(b.profile.createdAt) - ms(a.profile.createdAt);
  });
}

// ---------------------------------------------------------------------------
// Engine health
// ---------------------------------------------------------------------------

export const JOB_FAMILIES = [
  { key: 'sync', match: (name: string) => name === 'sync-google-ads', label: 'تحديث بيانات الحسابات', maxAgeHours: 4 },
  { key: 'optimize', match: (name: string) => name === 'optimize', label: 'المحسّن والتوصيات', maxAgeHours: 4 },
  {
    key: 'connect',
    match: (name: string) => name.startsWith('google_ads_connect:'),
    label: 'ربط الحسابات الجديدة',
    maxAgeHours: null,
  },
] as const;

export type JobFamilyHealth = {
  key: string;
  label: string;
  state: 'ok' | 'warning' | 'failing' | 'idle';
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  runs24h: number;
  failed24h: number;
  processed24h: number;
  errors24h: number;
  lastError: string | null;
  stateNote: string;
};

export type EngineHealth = {
  jobs: JobFamilyHealth[];
  webhooksFailed: number;
  webhookTypes: string[];
  recommendations: { created7d: number; applied7d: number; failed7d: number; dismissed7d: number; pending: number; stuck: number };
  actions: { executed7d: number; rolledBack7d: number };
  accounts: { active: number; googleDisabled: number; revoked: number; staleSync: number };
};

export function computeEngineHealth(data: OperatorDataset, now = Date.now()): EngineHealth {
  const dayAgo = now - DAY_MS;
  const weekAgo = now - 7 * DAY_MS;

  const jobs = JOB_FAMILIES.map((family) => {
    const runs = data.jobs
      .filter((job) => typeof job.job_name === 'string' && family.match(job.job_name))
      .sort((a, b) => ms(b.started_at) - ms(a.started_at));
    const last = runs[0] ?? null;
    const lastSuccess = runs.find((job) => job.status === 'success' || job.status === 'partial') ?? null;
    const recent = runs.filter((job) => ms(job.started_at) >= dayAgo);
    const failed = recent.filter((job) => job.status === 'failed');
    const lastFailure = runs.find((job) => job.status === 'failed' || (job.error_count ?? 0) > 0);
    const processed = recent.reduce((sum, job) => sum + Number(job.processed ?? 0), 0);
    const errors = recent.reduce((sum, job) => sum + Number(job.error_count ?? 0), 0);

    let state: JobFamilyHealth['state'] = 'ok';
    let stateNote = 'شغال طبيعي';
    const successAge = lastSuccess ? (now - ms(lastSuccess.started_at)) / HOUR_MS : Infinity;
    if (!last) {
      state = family.maxAgeHours ? 'failing' : 'idle';
      stateNote = family.maxAgeHours ? 'ما فيه أي تشغيل مسجل خلال 7 أيام' : 'ما فيه ربط جديد خلال 7 أيام';
    } else if (family.maxAgeHours && successAge > family.maxAgeHours) {
      state = 'failing';
      stateNote = lastSuccess
        ? `آخر نجاح قبل ${Math.round(successAge)} ساعة، والمفروض كل ${family.maxAgeHours} ساعات`
        : 'ولا تشغيل نجح خلال 7 أيام';
    } else if (failed.length > 0 || (processed + errors > 0 && errors / (processed + errors) > 0.1)) {
      state = 'warning';
      stateNote = failed.length > 0 ? `${failed.length} تشغيل فشل خلال 24 ساعة` : 'أخطاء على أكثر من 10% من الحسابات';
    }

    return {
      key: family.key,
      label: family.label,
      state,
      lastRunAt: last?.started_at ?? null,
      lastSuccessAt: lastSuccess?.started_at ?? null,
      runs24h: recent.length,
      failed24h: failed.length,
      processed24h: processed,
      errors24h: errors,
      lastError: lastFailure?.error_message ? String(lastFailure.error_message).slice(0, 300) : null,
      stateNote,
    };
  });

  const recs = data.recommendations;
  const createdThisWeek = recs.filter((rec) => ms(rec.created_at) >= weekAgo);
  const touchedThisWeek = (rec: Row) => ms(rec.applied_at ?? rec.created_at) >= weekAgo;

  const nonManager = data.accounts.filter((account) => !account.is_manager);
  const active = nonManager.filter((account) => account.status === 'active' && !isGoogleDisabled(account));

  return {
    jobs,
    webhooksFailed: data.webhooks.length,
    webhookTypes: Array.from(new Set(data.webhooks.map((hook) => String(hook.event_type ?? '')).filter(Boolean))).slice(0, 4),
    recommendations: {
      created7d: createdThisWeek.length,
      applied7d: recs.filter((rec) => rec.status === 'applied' && touchedThisWeek(rec)).length,
      failed7d: recs.filter((rec) => rec.status === 'failed' && touchedThisWeek(rec)).length,
      dismissed7d: recs.filter((rec) => rec.status === 'dismissed' && touchedThisWeek(rec)).length,
      pending: recs.filter((rec) => rec.status === 'pending').length,
      stuck: recs.filter(
        (rec) => rec.status === 'executing' && now - ms(rec.execution_started_at ?? rec.created_at) > 30 * 60 * 1000
      ).length,
    },
    actions: {
      executed7d: data.actions.filter((action) => ms(action.created_at) >= weekAgo).length,
      rolledBack7d: data.actions.filter((action) => action.rollback_status === 'reverted' && ms(action.reverted_at) >= weekAgo)
        .length,
    },
    accounts: {
      active: active.length,
      googleDisabled: nonManager.filter(isGoogleDisabled).length,
      revoked: nonManager.filter((account) => account.status === 'revoked').length,
      staleSync: active.filter((account) => !account.last_synced_at || now - ms(account.last_synced_at) > DAY_MS).length,
    },
  };
}

// ---------------------------------------------------------------------------
// The one sentence at the top
// ---------------------------------------------------------------------------

export function headline({
  attention,
  health,
  revenue,
}: {
  attention: AttentionItem[];
  health: EngineHealth;
  revenue: RevenueSummary;
}) {
  const failing = health.jobs.filter((job) => job.state === 'failing');
  const critical = attention.filter((item) => item.severity === 'critical').length;
  const chargesThisWeek = revenue.upcoming.slice(0, 7).reduce((sum, day) => sum + day.count, 0);

  if (failing.length > 0) {
    return {
      tone: 'danger' as const,
      text: `${failing.map((job) => job.label).join(' و')} ${failing.length > 1 ? 'واقفين' : 'واقف'}. هذا أول شي.`,
    };
  }
  if (critical > 0) {
    return {
      tone: 'danger' as const,
      text: critical === 1 ? 'عميل واحد يحتاجك اليوم قبل لا تخسره.' : `${critical} عملاء يحتاجونك اليوم قبل لا تخسرهم.`,
    };
  }
  if (attention.length > 0) {
    return {
      tone: 'warning' as const,
      text:
        attention.length === 1
          ? 'المحرك سليم، وعندك متابعة وحدة.'
          : `المحرك سليم، وعندك ${attention.length} متابعات.`,
    };
  }
  return {
    tone: 'success' as const,
    text: chargesThisWeek > 0 ? `كل شي سليم، و${chargesThisWeek} تجارب تتحول لدفع هالأسبوع.` : 'كل شي سليم.',
  };
}
