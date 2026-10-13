import { createAdminClient } from '@/lib/supabase/server';
import { isModaafaOperator } from '@/lib/platform/operators';
import { readAccessOverrides, type LiveAccessOverrides } from '@/lib/billing/access-overrides';

export type BillingPlan = 'starter' | 'growth' | 'pro';
export type MeteredFeature = 'assistant' | 'campaign_builder' | 'audit' | 'manual_sync' | 'execute_action';

type Period = 'day' | 'week' | 'month';

type FeatureLimit = {
  limit: number;
  period: Period;
};

export type SubscriptionAccess = {
  active: boolean;
  plan: BillingPlan | null;
  /**
   * Stripe status, or one of the local ones: 'internal' (operator), 'comp'
   * (free plan granted by an operator) and 'suspended' (an operator suspended
   * the account; nothing runs for it until they lift it).
   */
  status: string | null;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  suspended?: boolean;
};

export type FeatureAccessResult =
  | {
      ok: true;
      plan: BillingPlan;
      limit: number;
      used: number;
      remaining: number;
      resetsAt: string;
      usageEventId: string;
    }
  | {
      ok: false;
      reason: 'subscription_required' | 'account_suspended' | 'quota_exceeded' | 'usage_storage_unavailable';
      plan: BillingPlan | null;
      limit?: number;
      used?: number;
      resetsAt?: string;
    };

const ACTIVE_STATUSES = new Set(['trialing', 'active']);

export const PLAN_LIMITS: Record<BillingPlan, Record<MeteredFeature, FeatureLimit>> = {
  starter: {
    assistant: { limit: 20, period: 'day' },
    campaign_builder: { limit: 5, period: 'month' },
    audit: { limit: 2, period: 'week' },
    manual_sync: { limit: 5, period: 'day' },
    execute_action: { limit: 3, period: 'day' },
  },
  growth: {
    assistant: { limit: 100, period: 'day' },
    campaign_builder: { limit: 20, period: 'month' },
    audit: { limit: 7, period: 'week' },
    manual_sync: { limit: 20, period: 'day' },
    execute_action: { limit: 20, period: 'day' },
  },
  pro: {
    assistant: { limit: 500, period: 'day' },
    campaign_builder: { limit: 100, period: 'month' },
    audit: { limit: 70, period: 'week' },
    manual_sync: { limit: 100, period: 'day' },
    execute_action: { limit: 100, period: 'day' },
  },
};

/** Rank used to pick the most privileged live subscription. */
const PLAN_RANK: Record<BillingPlan, number> = { starter: 1, growth: 2, pro: 3 };

/**
 * The plan whose LIMITS apply to this access.
 *
 * A trial runs on Starter limits whatever plan was picked at checkout: the
 * trial is free, so it must not carry Growth or Pro quotas (assistant turns,
 * audits, LLM budget, optimizer accounts) that cost real money to serve. The
 * full limits start with the first payment, when Stripe moves the subscription
 * from `trialing` to `active`.
 *
 * Only access that comes from a Stripe subscription in `trialing` is capped.
 * An operator free-plan grant ('comp') and operator internal access
 * ('internal') are decisions someone made on purpose and keep their plan; the
 * 'comp' status is what tells them apart, because applyAccessOverrides replaces
 * the status when a grant wins over the trial.
 *
 * Use this, not `access.plan`, for every per-plan limit lookup. `access.plan`
 * is still the right value to DISPLAY (the plan the customer chose).
 */
export function effectiveLimitPlan(
  subscription: Pick<SubscriptionAccess, 'plan' | 'status'>
): BillingPlan | null {
  if (!subscription.plan) return null;
  return subscription.status === 'trialing' ? 'starter' : subscription.plan;
}

/**
 * `userId` is REQUIRED. It used to be optional, which meant three dashboard
 * pages called this with RLS as the only thing scoping the query. That works,
 * but it leaves no second line of defence: swapping in the admin client, or
 * disabling RLS during an incident, would silently turn an entitlement check
 * into a cross-tenant read.
 */
export async function getSubscriptionAccess(
  supabase: any,
  userId: string | null | undefined,
  authenticatedEmail?: string | null
): Promise<SubscriptionAccess> {
  return (await getSubscriptionAccessDetailed(supabase, userId, authenticatedEmail)).access;
}

export type DetailedSubscriptionAccess = {
  /** What the customer can use: billing access with operator overrides applied. */
  access: SubscriptionAccess;
  /**
   * Billing truth before overrides (Stripe, or operator internal access). The
   * billing page renders from this, so a free plan or a suspension never hides
   * a live Stripe subscription that is still charging the card.
   */
  billing: SubscriptionAccess;
  overrides: LiveAccessOverrides;
};

export async function getSubscriptionAccessDetailed(
  supabase: any,
  userId: string | null | undefined,
  authenticatedEmail?: string | null
): Promise<DetailedSubscriptionAccess> {
  const none: SubscriptionAccess = { active: false, plan: null, status: null, trialEndsAt: null, currentPeriodEnd: null };
  const noOverrides: LiveAccessOverrides = { suspended: false, suspendedAt: null, grant: null };
  if (!userId) {
    return { access: none, billing: none, overrides: noOverrides };
  }

  // Operators need to exercise the complete product without creating a fake
  // Stripe subscription. Keep them on the bounded Pro limits so a compromised
  // operator session cannot create unmetered Anthropic or Google Ads spend.
  // The email must come from the authenticated server-side Supabase user.
  if (isModaafaOperator(authenticatedEmail)) {
    const internal: SubscriptionAccess = {
      active: true,
      plan: 'pro',
      status: 'internal',
      trialEndsAt: null,
      currentPeriodEnd: null,
    };
    return { access: internal, billing: internal, overrides: noOverrides };
  }

  // Select by ENTITLEMENT, not by recency. Taking "the newest row" meant that
  // a user with more than one subscription row got the wrong answer: cancel a
  // duplicate and the cancelled row is the newest, so a still-paying customer
  // was locked out of everything.
  let query = supabase
    .from('subscriptions')
    .select('plan, status, trial_ends_at, current_period_start, current_period_end, created_at')
    .order('created_at', { ascending: false })
    .limit(10);

  query = query.eq('user_id', userId);

  // Operator overrides (free plan, suspension) are read alongside. A missing
  // overrides table reads as "none" so this check never fails because of it.
  const [{ data: rows, error }, overrides] = await Promise.all([
    query,
    readAccessOverrides(supabase, userId),
  ]);
  if (error) console.error('Failed to read subscription access', error);

  const fromStripe = subscriptionAccessFromRows((rows ?? []) as Array<Record<string, any>>);

  return { access: applyAccessOverrides(fromStripe, overrides), billing: fromStripe, overrides };
}

/**
 * The access one user's subscription rows grant, before operator overrides.
 *
 * Picks the most privileged ENTITLED row (highest plan, then latest period end),
 * falling back to the newest row so a lapsed customer still reports their last
 * plan and status. Shared by the per-request check above and the background jobs
 * (lib/platform/jobs.ts), so a job and a page cannot disagree about a plan.
 */
export function subscriptionAccessFromRows(
  rows: Array<Record<string, any>>,
  now = Date.now()
): SubscriptionAccess {
  const live = rows.filter((row) => isSubscriptionEntitled(row, now));
  const subscription =
    live.sort((a, b) => {
      const rank = (PLAN_RANK[b.plan as BillingPlan] ?? 0) - (PLAN_RANK[a.plan as BillingPlan] ?? 0);
      if (rank !== 0) return rank;
      return new Date(b.current_period_end ?? 0).getTime() - new Date(a.current_period_end ?? 0).getTime();
    })[0] ?? rows[0];

  const plan = subscription && isBillingPlan(subscription.plan) ? subscription.plan : null;
  return subscription
    ? {
        active: Boolean(plan && isSubscriptionEntitled(subscription, now)),
        plan,
        status: subscription.status ?? null,
        trialEndsAt: subscription.trial_ends_at ?? null,
        currentPeriodEnd: subscription.current_period_end ?? null,
      }
    : { active: false, plan: null, status: null, trialEndsAt: null, currentPeriodEnd: null };
}

/**
 * Layer operator overrides over the Stripe-derived access. A suspension wins
 * over everything (including a paid plan: billing is untouched, but nothing
 * runs). A free plan applies when there is no live paid plan, or when it is a
 * higher plan than the paid one.
 *
 * "The paid one" is what the subscription actually delivers, which is its
 * effectiveLimitPlan: a trial delivers Starter's limits whatever plan it picked.
 * Comparing the picked plan instead would let a trial on Pro hide a Growth grant
 * and drop the user to Starter.
 */
export function applyAccessOverrides(
  access: SubscriptionAccess,
  overrides: LiveAccessOverrides
): SubscriptionAccess {
  if (overrides.suspended) {
    return {
      active: false,
      plan: null,
      status: 'suspended',
      trialEndsAt: access.trialEndsAt,
      currentPeriodEnd: access.currentPeriodEnd,
      suspended: true,
    };
  }
  const grant = overrides.grant;
  if (grant) {
    const paidRank = access.active && access.plan ? PLAN_RANK[effectiveLimitPlan(access) ?? access.plan] : 0;
    if (PLAN_RANK[grant.plan] > paidRank) {
      return {
        active: true,
        plan: grant.plan,
        status: 'comp',
        trialEndsAt: null,
        currentPeriodEnd: grant.expiresAt,
      };
    }
  }
  return access;
}

/** Dunning grace for a past_due subscription, from the unpaid period's start. */
export const PAST_DUE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Whether a subscription row currently grants access.
 *
 * `past_due` counts for a short grace (PAST_DUE_GRACE_MS) inside the unpaid
 * period, never past its end. Stripe keeps
 * dunning a card for days after the first failed attempt; revoking the
 * assistant, audits and sync on the very first retry locked out customers who
 * were still paying and still recoverable.
 */
export function isSubscriptionEntitled(subscription: Record<string, any>, now = Date.now()) {
  const status = subscription.status;
  const periodEnd = subscription.current_period_end
    ? new Date(subscription.current_period_end).getTime()
    : null;

  if (status === 'trialing') {
    const trialEnd = subscription.trial_ends_at ? new Date(subscription.trial_ends_at).getTime() : null;
    return !trialEnd || trialEnd > now;
  }

  if (status === 'active') {
    return !periodEnd || periodEnd > now;
  }

  if (status === 'past_due') {
    if (!periodEnd || periodEnd <= now) return false;
    // A failed renewal (or a failed first charge after the trial) rolls
    // current_period_* forward to the NEW, unpaid period. Without a cap, a card
    // that never recovers kept full paid access for that entire month (and
    // indefinitely when Stripe leaves the subscription unpaid). Keep a short
    // dunning grace measured from the start of the unpaid period instead.
    const periodStart = subscription.current_period_start
      ? new Date(subscription.current_period_start).getTime()
      : null;
    if (periodStart && Number.isFinite(periodStart)) {
      return now < Math.min(periodEnd, periodStart + PAST_DUE_GRACE_MS);
    }
    return true;
  }

  return false;
}

/**
 * Reserve one metered request before starting expensive work. This makes the
 * limit effective even if several browser tabs submit at nearly the same time.
 */
export async function consumeFeatureUsage({
  supabase,
  userId,
  userEmail,
  feature,
  accountId,
  metadata,
}: {
  supabase: any;
  userId: string;
  userEmail: string | null | undefined;
  feature: MeteredFeature;
  accountId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<FeatureAccessResult> {
  const subscription = await getSubscriptionAccess(supabase, userId, userEmail);
  if (subscription.suspended) {
    return { ok: false, reason: 'account_suspended', plan: null };
  }
  if (!subscription.active || !subscription.plan) {
    return { ok: false, reason: 'subscription_required', plan: subscription.plan };
  }

  // Limits follow the EFFECTIVE plan (a trial runs on Starter limits); the plan
  // reported back stays the one the customer chose.
  const limitPlan = effectiveLimitPlan(subscription) ?? subscription.plan;
  const featureLimit = PLAN_LIMITS[limitPlan][feature];
  const { start, end } = usageWindow(featureLimit.period);
  const { data, error } = await supabase.rpc('consume_feature_usage', {
    p_user_id: userId,
    p_feature: feature,
    p_account_id: accountId ?? null,
    p_limit: featureLimit.limit,
    p_window_start: start.toISOString(),
    p_window_end: end.toISOString(),
    p_metadata: metadata ?? {},
  });

  if (error) {
    console.error('Failed to reserve feature usage', { feature, error });
    return { ok: false, reason: 'usage_storage_unavailable', plan: subscription.plan };
  }

  const reservation = Array.isArray(data) ? data[0] : data;
  const used = Number(reservation?.used ?? 0);
  if (!reservation?.allowed || !reservation?.event_id) {
    return {
      ok: false,
      reason: 'quota_exceeded',
      plan: subscription.plan,
      limit: featureLimit.limit,
      used,
      resetsAt: end.toISOString(),
    };
  }

  return {
    ok: true,
    plan: subscription.plan,
    limit: featureLimit.limit,
    used,
    remaining: Math.max(0, featureLimit.limit - used),
    resetsAt: end.toISOString(),
    usageEventId: String(reservation.event_id),
  };
}

export async function refundFeatureUsage({
  userId,
  usageEventId,
}: {
  userId: string;
  usageEventId?: string | null;
}) {
  if (!usageEventId) return false;

  try {
    // Refunds are a server-owned compensation action. The browser role can
    // reserve quota, but must never be able to delete its own usage ledger.
    const admin = createAdminClient();
    const { data, error } = await admin.rpc('refund_feature_usage', {
      p_user_id: userId,
      p_event_id: usageEventId,
    });
    if (error) {
      console.error('Failed to refund feature usage', { usageEventId, error });
      return false;
    }
    return data === true;
  } catch (error) {
    console.error('Failed to create the usage refund service client', {
      usageEventId,
      error,
    });
    return false;
  }
}

export const ACCOUNT_SUSPENDED_MESSAGE =
  'حسابك موقوف مؤقتاً، ولن تُنفذ أي عملية عليه حتى يُعاد تفعيله. تواصل معنا على واتساب 0541004029.';

export function featureAccessMessage(reason?: string) {
  if (reason === 'account_suspended') return ACCOUNT_SUSPENDED_MESSAGE;
  if (reason === 'subscription_required') {
    return 'هذه الخاصية تحتاج تجربة أو اشتراكاً نشطاً. اختر الخطة المناسبة ثم أعد المحاولة.';
  }
  if (reason === 'quota_exceeded') {
    return 'وصلت إلى حد الاستخدام المتاح في خطتك لهذه الفترة. يمكنك الترقية أو الانتظار حتى يتجدد الحد.';
  }
  if (reason === 'usage_storage_unavailable') {
    return 'تعذر التحقق من حد الاستخدام الآن. لم ننفذ العملية لحماية حسابك، وأعد المحاولة بعد قليل.';
  }
  return 'تعذر التحقق من صلاحية هذه العملية.';
}

export function featureAccessStatus(reason?: string) {
  if (reason === 'account_suspended') return 403;
  if (reason === 'subscription_required') return 402;
  if (reason === 'quota_exceeded') return 429;
  return 503;
}

export function usageWindow(period: Period, now = new Date()) {
  const start = new Date(now);
  const end = new Date(now);

  if (period === 'day') {
    start.setUTCHours(0, 0, 0, 0);
    end.setUTCHours(24, 0, 0, 0);
  } else if (period === 'week') {
    const day = start.getUTCDay();
    const daysSinceSaturday = (day + 1) % 7;
    start.setUTCDate(start.getUTCDate() - daysSinceSaturday);
    start.setUTCHours(0, 0, 0, 0);
    end.setTime(start.getTime());
    end.setUTCDate(end.getUTCDate() + 7);
  } else {
    start.setUTCDate(1);
    start.setUTCHours(0, 0, 0, 0);
    end.setUTCFullYear(start.getUTCFullYear(), start.getUTCMonth() + 1, 1);
    end.setUTCHours(0, 0, 0, 0);
  }

  return { start, end };
}

function isBillingPlan(value: unknown): value is BillingPlan {
  return value === 'starter' || value === 'growth' || value === 'pro';
}
