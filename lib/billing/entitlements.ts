import { createAdminClient } from '@/lib/supabase/server';

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
  status: string | null;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
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
      reason: 'subscription_required' | 'quota_exceeded' | 'usage_storage_unavailable';
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
 * `userId` is REQUIRED. It used to be optional, which meant three dashboard
 * pages called this with RLS as the only thing scoping the query. That works,
 * but it leaves no second line of defence: swapping in the admin client, or
 * disabling RLS during an incident, would silently turn an entitlement check
 * into a cross-tenant read.
 */
export async function getSubscriptionAccess(supabase: any, userId: string | null | undefined): Promise<SubscriptionAccess> {
  if (!userId) {
    return { active: false, plan: null, status: null, trialEndsAt: null, currentPeriodEnd: null };
  }

  // Select by ENTITLEMENT, not by recency. Taking "the newest row" meant that
  // a user with more than one subscription row got the wrong answer: cancel a
  // duplicate and the cancelled row is the newest, so a still-paying customer
  // was locked out of everything.
  let query = supabase
    .from('subscriptions')
    .select('plan, status, trial_ends_at, current_period_end, created_at')
    .order('created_at', { ascending: false })
    .limit(10);

  query = query.eq('user_id', userId);

  const { data: rows, error } = await query;
  if (error) console.error('Failed to read subscription access', error);

  const subscriptions = (rows ?? []) as Array<Record<string, any>>;
  const live = subscriptions.filter((row) => isSubscriptionEntitled(row));
  const subscription =
    live.sort((a, b) => {
      const rank = (PLAN_RANK[b.plan as BillingPlan] ?? 0) - (PLAN_RANK[a.plan as BillingPlan] ?? 0);
      if (rank !== 0) return rank;
      return new Date(b.current_period_end ?? 0).getTime() - new Date(a.current_period_end ?? 0).getTime();
    })[0] ?? subscriptions[0];

  if (!subscription) {
    return {
      active: false,
      plan: null,
      status: null,
      trialEndsAt: null,
      currentPeriodEnd: null,
    };
  }

  const plan = isBillingPlan(subscription.plan) ? subscription.plan : null;
  return {
    active: Boolean(plan && isSubscriptionEntitled(subscription)),
    plan,
    status: subscription.status ?? null,
    trialEndsAt: subscription.trial_ends_at ?? null,
    currentPeriodEnd: subscription.current_period_end ?? null,
  };
}

/**
 * Whether a subscription row currently grants access.
 *
 * `past_due` counts until the current period actually ends. Stripe keeps
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
    return Boolean(periodEnd && periodEnd > now);
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
  feature,
  accountId,
  metadata,
}: {
  supabase: any;
  userId: string;
  feature: MeteredFeature;
  accountId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<FeatureAccessResult> {
  const subscription = await getSubscriptionAccess(supabase, userId);
  if (!subscription.active || !subscription.plan) {
    return { ok: false, reason: 'subscription_required', plan: subscription.plan };
  }

  const featureLimit = PLAN_LIMITS[subscription.plan][feature];
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

export function featureAccessMessage(reason?: string) {
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
