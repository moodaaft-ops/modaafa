import { partitionGoogleAdsAccounts, type AdsAccountSummary } from '@/lib/accounts/selection';
import { retrieveStripeSubscription } from '@/lib/billing/stripe';
import { getBillingCheckoutContext } from '@/lib/billing/checkout-policy';
import { googleAdsAccountNameMissing } from '@/lib/accounts/display';
import { OPEN_DECISION_STATUSES, PLAN_DECISION_LIMIT, toPlanRecommendations } from '@/lib/plan/load';
import { buildPlan, type PlanAuditRow } from '@/lib/plan/plan';
import { isAdaptiveOnboarding } from '@/lib/setup/adaptive/flag';
import { adaptiveLockedPlan } from '@/lib/setup/adaptive/locked-plan';
import { planLabel } from '@/lib/ui/labels';
import {
  EMPTY_FACTS,
  type BillingFacts,
  type EmailFacts,
  type FactNeed,
  type PlanFacts,
  type TrialFacts,
  type TrialTrack,
  type WeeklyFacts,
} from './types';
import { LIFECYCLE_ACCOUNT_STATUSES, pickLifecycleAccount } from './facts/account';
import { trialSpendFrom, type CachedCostRow } from './facts/spend';
import { firstNameOf, highlightsFrom } from './facts/text';
import { riyadhDay, saudiWeekStart } from './riyadh';

/**
 * The data an email is allowed to say, read fresh at send time.
 *
 * - Reads only what `needs` asks for, in parallel where the reads do not depend
 *   on each other. firstName and businessName are always filled (they are
 *   cheap: one `businesses` row, and the account list only when the business
 *   has no onboarding name).
 * - NEVER throws and NEVER invents. Any read that fails (error object or
 *   exception) turns exactly that fact into null and is logged once; a plan
 *   with no waste estimate has `wasteEstimate: null`; a stored weekly report
 *   with no spend figure has `spend: null`.
 * - The selected Google Ads account is found the way the app does it
 *   (lib/accounts/selection.getAccountWorkspace): the user's newest business,
 *   its active non-manager accounts newest-linked first, the persisted
 *   selected_google_ads_customer_id first, else the first one. A cron has no
 *   cookie, so the cookie step is skipped.
 *
 * Tables and columns read (all through the service client, all filtered by the
 * user's own id or the user's own account id):
 *   businesses            id, name, sector, ...   -> firstName/businessName, account lookup
 *   google_ads_accounts   id, customer_id, customer_name, currency_code, status, is_manager
 *   audits, recommendations   the same two reads lib/plan/load.loadPlan makes
 *   subscriptions         plan, status, trial_ends_at, created_at   -> trial, billing
 *   recommendations       status in OPEN_DECISION_STATUSES          -> pendingCount (pending + approved-not-executed,
 *                                                                          the rows /home lists as waiting)
 *   ai_actions            action_type = 'approval_queued'           -> approvedCount
 *   ai_actions            rollback_status = 'reverted'              -> rolledBackCount (since the trial started)
 *   campaigns_cache       metrics_30d cost of the linked accounts   -> adsSpend30 and the trial track (spend.ts)
 *   Stripe (live)         cancel_at_period_end / cancel_at          -> trial.cancelScheduled, only for a copy that lists
 *                                                                          'cancel_state' (our table does not store it)
 *   reports               metrics.kind = 'weekly_performance'       -> weekly (only one generated in the current Saudi
 *                                                                          week, see saudiWeekStart)
 *   users                 email (only when the adaptive onboarding may be on)
 *   auth.admin.getUserById + billing_trial_grants / subscriptions / billing_trial_ledger / businesses /
 *   google_ads_accounts / trial_customer_ledger   -> plan.trialEligible (lib/billing/checkout-policy, the paywall's rule)
 */
export type LoadFactsOptions = {
  /** For tests. */
  now?: Date;
  /** For tests: where the adaptive-onboarding flags are read from. */
  env?: Record<string, string | undefined>;
  /** For tests: reads the live Stripe subscription (default: lib/billing/stripe retrieveStripeSubscription). */
  retrieveSubscription?: (id: string) => Promise<{ cancel_at_period_end?: boolean | null; cancel_at?: number | null }>;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const BUSINESS_NAME_MAX = 120;
const LIST_LIMIT = 1000;

const BUSINESS_COLUMNS =
  'id, name, sector, website, monthly_budget, primary_goal, target_regions, selected_google_ads_customer_id';
const ACCOUNT_COLUMNS = 'id, customer_id, customer_name, manager_id, status, is_manager, currency_code, last_synced_at';

type BusinessRow = {
  id: string;
  name?: string | null;
  sector?: string | null;
  website?: string | null;
  monthly_budget?: number | null;
  primary_goal?: string | null;
  target_regions?: string[] | null;
  selected_google_ads_customer_id?: string | null;
};

type AccountRow = AdsAccountSummary & { currency_code?: string | null };

type SubscriptionRow = {
  plan?: string | null;
  status?: string | null;
  trial_ends_at?: string | null;
  created_at?: string | null;
  stripe_subscription_id?: string | null;
};

type IdRow = { id?: string | null; recommendation_id?: string | null };

type ReportMetrics = {
  kind?: string | null;
  currency_code?: string | null;
  totals?: {
    this_week?: { cost?: unknown; conversions?: unknown } | null;
    prior_week?: { cost?: unknown; conversions?: unknown } | null;
    delta?: { cpa_this?: unknown } | null;
  } | null;
  highlights_ar?: unknown;
};

type ReportRow = {
  summary_ar?: string | null;
  generated_at?: string | null;
  metrics?: ReportMetrics | null;
};

type Read<T> = { ok: true; data: T } | { ok: false };

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function validIso(value: unknown): string | null {
  const raw = text(value);
  return raw && Number.isFinite(Date.parse(raw)) ? raw : null;
}

export async function loadEmailFacts(
  admin: any,
  user: { id: string; name: string | null },
  needs: FactNeed[],
  options: LoadFactsOptions = {}
): Promise<EmailFacts> {
  try {
    return await load(admin, user, new Set(needs), options);
  } catch (error) {
    // Unreachable in practice (every read below is guarded), but a fact loader
    // must never be the reason a send crashes.
    console.error('[email-facts] unexpected failure', { userId: user?.id, message: errorMessage(error) });
    return { ...EMPTY_FACTS, firstName: firstNameOf(user?.name ?? null) };
  }
}

async function load(
  admin: any,
  user: { id: string; name: string | null },
  want: Set<FactNeed>,
  options: LoadFactsOptions
): Promise<EmailFacts> {
  const now = options.now ?? new Date();
  const env = options.env ?? process.env;
  const logged = new Set<string>();

  /** One awaited read: an error object, a throw or a missing client all become `{ ok: false }`, logged once per label. */
  const read = async <T>(label: string, run: () => PromiseLike<{ data: T; error?: unknown }>): Promise<Read<T>> => {
    try {
      const result = await run();
      if (!result || result.error) {
        note(label, result?.error);
        return { ok: false };
      }
      return { ok: true, data: result.data };
    } catch (error) {
      note(label, error);
      return { ok: false };
    }
  };
  const note = (label: string, error: unknown) => {
    if (logged.has(label)) return;
    logged.add(label);
    console.error('[email-facts] read failed, fact left empty', { userId: user.id, read: label, code: errorCode(error) });
  };

  const wantPlan = want.has('plan');
  const wantTrial = want.has('trial');
  const wantWeekly = want.has('weekly');
  const wantBilling = want.has('billing');
  const wantCancelState = want.has('cancel_state');
  const adaptiveMayBeOn = wantPlan && (env.ADAPTIVE_ONBOARDING === 'true' || env.ADAPTIVE_ONBOARDING === 'operators');

  // ---- Round 1: reads that need nothing but the user id.
  const [businessRead, subscriptionsRead, emailRead] = await Promise.all([
    read<BusinessRow | null>('businesses', () =>
      admin
        .from('businesses')
        .select(BUSINESS_COLUMNS)
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
    ),
    wantTrial || wantBilling
      ? read<SubscriptionRow[]>('subscriptions', () =>
          admin
            .from('subscriptions')
            .select('plan, status, trial_ends_at, created_at, stripe_subscription_id')
            .eq('user_id', user.id)
            .order('created_at', { ascending: false })
            .limit(10)
        )
      : Promise.resolve(null),
    adaptiveMayBeOn
      ? read<{ email?: string | null } | null>('users', () =>
          admin.from('users').select('email').eq('id', user.id).maybeSingle()
        )
      : Promise.resolve(null),
  ]);

  const business = businessRead.ok ? businessRead.data ?? null : null;
  const subscriptions = subscriptionsRead?.ok ? subscriptionsRead.data ?? [] : [];
  const trialRow = subscriptionsRead?.ok ? subscriptions.find((row) => row?.status === 'trialing') ?? null : null;

  // ---- Round 2: the account list (only when something needs an account or the name).
  const onboardingName = business && text(business.sector) ? text(business.name) : null;
  // A trial fact needs the account only when there is a trial to count approvals for.
  const needsAccount = wantPlan || wantWeekly || (wantTrial && trialRow !== null);
  const needsAccountName = !onboardingName;
  let account: AccountRow | null = null;
  let accountsRead: Read<AdsAccountSummary[]> | null = null;
  if (business && (needsAccount || needsAccountName)) {
    accountsRead = await read<AdsAccountSummary[]>('google_ads_accounts', () =>
      admin
        .from('google_ads_accounts')
        .select(ACCOUNT_COLUMNS)
        .eq('business_id', business.id)
        .in('status', [...LIFECYCLE_ACCOUNT_STATUSES])
        .order('linked_at', { ascending: false })
        .limit(500)
    );
    if (accountsRead.ok) {
      account = pickLifecycleAccount(
        (accountsRead.data ?? []) as AccountRow[],
        business.selected_google_ads_customer_id ?? null
      );
    }
  }

  const businessName = (
    onboardingName ??
    (account && !googleAdsAccountNameMissing(account) ? text(account.customer_name) : null)
  )?.slice(0, BUSINESS_NAME_MAX) ?? null;

  // "Known" = we can tell which account (or that there is none): the business read worked, and either there is
  // no business row at all or its account list was read. An unknown account makes every account-bound fact null.
  const accountKnown = businessRead.ok && (!business || accountsRead?.ok === true);
  const currency = String(account?.currency_code ?? 'SAR').toUpperCase();

  // ---- Round 3: everything that hangs off the account, in parallel. The open-decisions count is shared.
  let pendingPromise: Promise<Read<number>> | null = null;
  const pendingCount = () => {
    if (!account) return Promise.resolve<Read<number>>({ ok: true, data: 0 });
    if (!pendingPromise) {
      const accountId = account.id;
      // Same statuses /home lists as waiting: undecided AND approved-but-not-executed ones.
      pendingPromise = read<IdRow[]>('recommendations_pending', () =>
        admin
          .from('recommendations')
          .select('id')
          .eq('account_id', accountId)
          .in('status', [...OPEN_DECISION_STATUSES])
          .limit(LIST_LIMIT)
      ).then((res): Read<number> => (res.ok ? { ok: true, data: (res.data ?? []).length } : { ok: false }));
    }
    return pendingPromise;
  };

  const planTask = async (): Promise<PlanFacts | null> => {
    if (!wantPlan || !account) return null;
    const adaptiveOn = adaptiveMayBeOn ? (emailRead?.ok ? isAdaptiveOnboarding(env, emailRead.data?.email ?? null) : null) : false;
    // Cannot tell whether the plan screen applies the adaptive rules: say nothing rather than guess.
    if (adaptiveOn === null) return null;

    const accountId = account.id;
    const [auditRead, recsRead] = await Promise.all([
      read<PlanAuditRow | null>('audits', () =>
        admin
          .from('audits')
          .select('health_score, estimated_monthly_waste, ran_at')
          .eq('account_id', accountId)
          .order('ran_at', { ascending: false })
          .limit(1)
          .maybeSingle()
      ),
      read<unknown[]>('recommendations_plan', () =>
        admin
          .from('recommendations')
          .select('id, title, description, severity, status, category, expected_impact, action_payload, created_at')
          .eq('account_id', accountId)
          .in('status', ['pending', 'approved'])
          .order('created_at', { ascending: false })
          .limit(PLAN_DECISION_LIMIT)
      ),
    ]);
    if (!auditRead.ok || !recsRead.ok) return null;

    let plan = buildPlan({
      audit: auditRead.data ?? null,
      recommendations: toPlanRecommendations(recsRead.data ?? []),
      currency,
      includeCategory: adaptiveOn,
    });
    let leadTitle: string | null = null;
    if (adaptiveOn) {
      // The same correction /home, /optimizer and /audit apply (lib/plan/load.loadPlanLock): a rules decision may
      // lead, and an account that cannot say what its ads bring has no waste number. Never throws.
      const locked = await adaptiveLockedPlan({ admin, accountId, business, plan, currency, now });
      plan = locked.plan;
      leadTitle = text(locked.lead?.title);
    }
    // No audit on record means the screen says «ما جهزت خطتك للحين»: there is no plan to talk about.
    if (plan.kind === 'no_audit') return null;
    return {
      decisionsTotal: plan.decisionsCount,
      lockedCount: plan.locked.length,
      firstDecisionTitle: text(plan.first?.title) ?? leadTitle,
      wasteEstimate: plan.waste,
      currency: plan.currency,
      trialEligible: await trialEligibility(),
    };
  };

  /**
   * Can this person still start the free trial? The paywall's own rule: the same getBillingCheckoutContext call
   * /home and loadPlanLock make, so the mail never promises a trial the button would refuse. The address it is
   * asked about is the sign-in identity (Supabase Auth, what the paywall reads from the session), never the
   * client-writable users.email. Anything that cannot be settled is null, and so is a ledger lookup that failed
   * (`check_failed`: nothing is known to be wrong, it just could not be checked): the copy then says nothing
   * about a free trial instead of guessing either way.
   */
  const trialEligibility = async (): Promise<boolean | null> => {
    try {
      const identity = await admin.auth.admin.getUserById(user.id);
      const email = text(identity?.data?.user?.email);
      if (!email) {
        note('auth_user', identity?.error);
        return null;
      }
      const checkout = await getBillingCheckoutContext(admin, user.id, email, { admin });
      if (checkout.trialIneligibleReason === 'check_failed') return null;
      return checkout.trialEligible;
    } catch (error) {
      note('trial_eligibility', error);
      return null;
    }
  };

  const trialTask = async (): Promise<TrialFacts | null> => {
    if (!wantTrial || !subscriptionsRead?.ok || !trialRow) return null;
    const startedAt = validIso(trialRow.created_at);
    if (!startedAt) return null;
    if (!accountKnown) return null;

    let approvedCount = 0;
    let pending = 0;
    let rolledBackCount: number | null = null;
    let adsSpend30: number | null = null;
    let track: TrialTrack | null = null;
    if (account) {
      const accountId = account.id;
      // The linked accounts the spend is summed over: every active client account of the business, not only the
      // selected one (a person can run ads from several).
      const linked = partitionGoogleAdsAccounts((accountsRead?.ok ? accountsRead.data ?? [] : []) as AccountRow[]).accounts;
      const linkedIds = linked.map((row) => row.id);
      const [approvedRead, pendingRead, revertedRead, cacheRead] = await Promise.all([
        read<IdRow[]>('ai_actions', () =>
          admin
            .from('ai_actions')
            .select('id, recommendation_id')
            .eq('account_id', accountId)
            .eq('action_type', 'approval_queued')
            .gte('created_at', startedAt)
            .limit(LIST_LIMIT)
        ),
        pendingCount(),
        read<IdRow[]>('ai_actions', () =>
          admin
            .from('ai_actions')
            .select('id, recommendation_id')
            .eq('account_id', accountId)
            .eq('rollback_status', 'reverted')
            .gte('created_at', startedAt)
            .limit(LIST_LIMIT)
        ),
        linkedIds.length > 0
          ? read<CachedCostRow[]>('campaigns_cache', () =>
              admin.from('campaigns_cache').select('metrics_30d').in('account_id', linkedIds).limit(LIST_LIMIT)
            )
          : Promise.resolve<Read<CachedCostRow[]>>({ ok: true, data: [] }),
      ]);
      if (!approvedRead.ok || !pendingRead.ok) return null;
      // One approval is one recommendation, even if it was approved again after a failed execution.
      approvedCount = new Set((approvedRead.data ?? []).map((row) => row?.recommendation_id ?? row?.id)).size;
      pending = pendingRead.data;
      // The two reads below only enrich the mail: when one fails the sentence or the track that needs it is left out.
      if (revertedRead.ok) {
        rolledBackCount = new Set((revertedRead.data ?? []).map((row) => row?.recommendation_id ?? row?.id)).size;
      }
      ({ spend30: adsSpend30, track } = trialSpendFrom({
        rows: cacheRead.ok ? cacheRead.data ?? [] : null,
        syncedAt: linked.map((row) => row.last_synced_at),
        now,
      }));
    }

    const endsAt = validIso(trialRow.trial_ends_at);
    // Whole days remaining, rounded UP: 9 days 22 hours left is "10 days", the last partial day still counts, and
    // an ended trial is 0 (never negative). Riyadh is a fixed UTC+3 with no daylight saving, so elapsed time is exact.
    const daysLeft = endsAt ? Math.max(0, Math.ceil((Date.parse(endsAt) - now.getTime()) / DAY_MS)) : null;
    const facts: TrialFacts = { startedAt, endsAt, daysLeft, approvedCount, pendingCount: pending, rolledBackCount, adsSpend30, track };
    if (wantCancelState) facts.cancelScheduled = await cancelScheduled(trialRow.stripe_subscription_id);
    return facts;
  };

  /**
   * Is a cancellation scheduled in Stripe? Our table does not store cancel_at_period_end, so this reads the live
   * subscription, the way the billing page and the trial_will_end handler do. null = cannot be told (no Stripe id,
   * Stripe unreachable): the runner then holds the mail and tries again, it never guesses.
   */
  const cancelScheduled = async (stripeSubscriptionId: string | null | undefined): Promise<boolean | null> => {
    const id = text(stripeSubscriptionId);
    if (!id) return null;
    try {
      const live = await (options.retrieveSubscription ?? retrieveStripeSubscription)(id);
      return Boolean(live?.cancel_at_period_end || live?.cancel_at);
    } catch (error) {
      note('stripe_subscription', error);
      return null;
    }
  };

  const weeklyTask = async (): Promise<WeeklyFacts | null> => {
    if (!wantWeekly || !account) return null;
    const accountId = account.id;
    // Only this Saudi week's report: the optimize cron writes one per account per week (Saturday 00:00 UTC
    // onward), so an older one is last week's numbers and must not go out under this week's subject.
    const since = saudiWeekStart(now).toISOString();
    const [reportsRead, pendingRead] = await Promise.all([
      read<ReportRow[]>('reports', () =>
        admin
          .from('reports')
          .select('summary_ar, metrics, generated_at')
          .eq('account_id', accountId)
          .eq('period_type', 'weekly')
          .gte('generated_at', since)
          .order('generated_at', { ascending: false })
          .limit(10)
      ),
      pendingCount(),
    ]);
    if (!reportsRead.ok || !pendingRead.ok) return null;
    const report = (reportsRead.data ?? []).find((row) => row?.metrics?.kind === 'weekly_performance');
    if (!report) return null;

    const metrics = report.metrics ?? {};
    const thisWeek = metrics.totals?.this_week ?? {};
    const priorWeek = metrics.totals?.prior_week ?? {};
    const spend = finite(thisWeek.cost);
    const conversions = finite(thisWeek.conversions);
    const storedCpa = finite(metrics.totals?.delta?.cpa_this);
    const costPerConversion =
      storedCpa !== null ? storedCpa : spend !== null && conversions !== null && conversions > 0 ? round2(spend / conversions) : null;

    // The days the numbers really cover. The optimize cron queries LAST_7_DAYS (the seven days that ended
    // YESTERDAY) but stores period_end = the generation day and period_start = 7 days before it, so the stored
    // columns would label the week one day late. Derive the range from the generation time instead, on the
    // Riyadh calendar: end = the day before generation, start = end - 6 days (seven days inclusive).
    const generatedAt = validIso(report.generated_at);
    if (!generatedAt) return null;
    const generatedMs = Date.parse(generatedAt);
    const periodEnd = riyadhDay(new Date(generatedMs - DAY_MS));
    const periodStart = riyadhDay(new Date(generatedMs - 7 * DAY_MS));

    return {
      periodStart,
      periodEnd,
      currency: String(text(metrics.currency_code) ?? currency).toUpperCase(),
      spend,
      conversions,
      costPerConversion,
      prevSpend: finite(priorWeek.cost),
      prevConversions: finite(priorWeek.conversions),
      highlights: highlightsFrom({ highlights: metrics.highlights_ar, summary: report.summary_ar }),
      pendingCount: pendingRead.data,
    };
  };

  const billingFacts = (): BillingFacts | null => {
    if (!wantBilling || !subscriptionsRead?.ok) return null;
    const latest = subscriptions[0];
    if (!latest) return null;
    const plan = ['starter', 'growth', 'pro'].includes(String(latest.plan)) ? planLabel(latest.plan) : null;
    return { planName: plan, trialEndsAt: validIso(latest.trial_ends_at) };
  };

  const [plan, trial, weekly] = await Promise.all([planTask(), trialTask(), weeklyTask()]);

  return {
    firstName: firstNameOf(user.name),
    businessName,
    plan,
    trial,
    weekly,
    billing: billingFacts(),
  };
}

function errorCode(error: unknown): string {
  if (error && typeof error === 'object') {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' || typeof code === 'number') return String(code);
  }
  return error instanceof Error ? error.name : 'error';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : 'unknown';
}
