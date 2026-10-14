import { partitionGoogleAdsAccounts, pickSelectedAdsAccount, type AdsAccountSummary } from '@/lib/accounts/selection';
import { googleAdsAccountNameMissing } from '@/lib/accounts/display';
import { PLAN_DECISION_LIMIT, toPlanRecommendations } from '@/lib/plan/load';
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
  type WeeklyFacts,
} from './types';
import { firstNameOf, highlightsFrom } from './facts/text';

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
 *   recommendations       status = 'pending'                        -> pendingCount
 *   ai_actions            action_type = 'approval_queued'           -> approvedCount
 *   reports               metrics.kind = 'weekly_performance'       -> weekly
 *   users                 email (only when the adaptive onboarding may be on)
 */
export type LoadFactsOptions = {
  /** For tests. */
  now?: Date;
  /** For tests: where the adaptive-onboarding flags are read from. */
  env?: Record<string, string | undefined>;
};

const DAY_MS = 24 * 60 * 60 * 1000;
/** A weekly report is "this week's" while it is at most this old. */
export const WEEKLY_REPORT_MAX_AGE_DAYS = 8;
const BUSINESS_NAME_MAX = 120;
const LIST_LIMIT = 1000;

const BUSINESS_COLUMNS =
  'id, name, sector, website, monthly_budget, primary_goal, target_regions, selected_google_ads_customer_id';
const ACCOUNT_COLUMNS = 'id, customer_id, customer_name, manager_id, status, is_manager, currency_code';

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
  period_start?: string | null;
  period_end?: string | null;
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
            .select('plan, status, trial_ends_at, created_at')
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
        .in('status', ['active', 'revoked', 'paused'])
        .order('linked_at', { ascending: false })
        .limit(500)
    );
    if (accountsRead.ok) {
      const { accounts } = partitionGoogleAdsAccounts(accountsRead.data ?? []);
      account = pickSelectedAdsAccount(accounts, null, business.selected_google_ads_customer_id ?? null) as AccountRow | null;
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
      pendingPromise = read<IdRow[]>('recommendations_pending', () =>
        admin.from('recommendations').select('id').eq('account_id', accountId).eq('status', 'pending').limit(LIST_LIMIT)
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
    };
  };

  const trialTask = async (): Promise<TrialFacts | null> => {
    if (!wantTrial || !subscriptionsRead?.ok || !trialRow) return null;
    const startedAt = validIso(trialRow.created_at);
    if (!startedAt) return null;
    if (!accountKnown) return null;

    let approvedCount = 0;
    let pending = 0;
    if (account) {
      const accountId = account.id;
      const [approvedRead, pendingRead] = await Promise.all([
        read<IdRow[]>('ai_actions_approved', () =>
          admin
            .from('ai_actions')
            .select('id, recommendation_id')
            .eq('account_id', accountId)
            .eq('action_type', 'approval_queued')
            .gte('created_at', startedAt)
            .limit(LIST_LIMIT)
        ),
        pendingCount(),
      ]);
      if (!approvedRead.ok || !pendingRead.ok) return null;
      // One approval is one recommendation, even if it was approved again after a failed execution.
      approvedCount = new Set((approvedRead.data ?? []).map((row) => row?.recommendation_id ?? row?.id)).size;
      pending = pendingRead.data;
    }

    const endsAt = validIso(trialRow.trial_ends_at);
    // Whole days left, rounded down. Riyadh is a fixed UTC+3 with no daylight saving, so elapsed time is exact.
    const daysLeft = endsAt ? Math.max(0, Math.floor((Date.parse(endsAt) - now.getTime()) / DAY_MS)) : null;
    return { startedAt, endsAt, daysLeft, approvedCount, pendingCount: pending };
  };

  const weeklyTask = async (): Promise<WeeklyFacts | null> => {
    if (!wantWeekly || !account) return null;
    const accountId = account.id;
    const since = new Date(now.getTime() - WEEKLY_REPORT_MAX_AGE_DAYS * DAY_MS).toISOString();
    const [reportsRead, pendingRead] = await Promise.all([
      read<ReportRow[]>('reports', () =>
        admin
          .from('reports')
          .select('period_start, period_end, summary_ar, metrics, generated_at')
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

    const generatedAt = validIso(report.generated_at);
    const periodEnd = text(report.period_end) ?? generatedAt?.slice(0, 10) ?? null;
    if (!periodEnd) return null;
    const periodStart =
      text(report.period_start) ?? new Date(Date.parse(periodEnd) - 7 * DAY_MS).toISOString().slice(0, 10);

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
