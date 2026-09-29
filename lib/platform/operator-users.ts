/**
 * Joins the per-user rows the operations center reads into one row per user.
 * Pure so it can be tested without Supabase.
 */

export type OperatorUserRow = {
  id: string;
  email: string;
  name: string | null;
  createdAt: string | null;
  lastLoginAt: string | null;
  businessName: string | null;
  plan: string | null;
  subscriptionStatus: string | null;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  activeAdAccounts: number;
  usageLast7Days: number;
};

const LIVE_STATUSES = new Set(['trialing', 'active', 'past_due', 'paused']);

export function buildOperatorUserRows(input: {
  users: Array<Record<string, any>>;
  subscriptions: Array<Record<string, any>>;
  businesses: Array<Record<string, any>>;
  accounts: Array<Record<string, any>>;
  usage: Array<Record<string, any>>;
}): OperatorUserRow[] {
  const businessByUser = new Map<string, Record<string, any>>();
  const userByBusiness = new Map<string, string>();
  for (const business of input.businesses) {
    if (!business.user_id) continue;
    businessByUser.set(business.user_id, business);
    userByBusiness.set(business.id, business.user_id);
  }

  const accountsByUser = new Map<string, number>();
  for (const account of input.accounts) {
    const userId = userByBusiness.get(account.business_id);
    if (!userId || account.status !== 'active' || account.is_manager) continue;
    accountsByUser.set(userId, (accountsByUser.get(userId) ?? 0) + 1);
  }

  const usageByUser = new Map<string, number>();
  for (const event of input.usage) {
    if (!event.user_id) continue;
    usageByUser.set(event.user_id, (usageByUser.get(event.user_id) ?? 0) + 1);
  }

  // Prefer a live subscription; otherwise the most recent one.
  const subscriptionByUser = new Map<string, Record<string, any>>();
  for (const subscription of input.subscriptions) {
    const current = subscriptionByUser.get(subscription.user_id);
    if (!current) {
      subscriptionByUser.set(subscription.user_id, subscription);
      continue;
    }
    const currentLive = LIVE_STATUSES.has(current.status);
    const nextLive = LIVE_STATUSES.has(subscription.status);
    const newer = String(subscription.created_at ?? '') > String(current.created_at ?? '');
    if ((nextLive && !currentLive) || (nextLive === currentLive && newer)) {
      subscriptionByUser.set(subscription.user_id, subscription);
    }
  }

  return input.users.map((user) => {
    const subscription = subscriptionByUser.get(user.id);
    return {
      id: user.id,
      email: user.email ?? '',
      name: user.name ?? null,
      createdAt: user.created_at ?? null,
      lastLoginAt: user.last_login_at ?? null,
      businessName: businessByUser.get(user.id)?.name ?? null,
      plan: subscription?.plan ?? null,
      subscriptionStatus: subscription?.status ?? null,
      trialEndsAt: subscription?.trial_ends_at ?? null,
      currentPeriodEnd: subscription?.current_period_end ?? null,
      activeAdAccounts: accountsByUser.get(user.id) ?? 0,
      usageLast7Days: usageByUser.get(user.id) ?? 0,
    };
  });
}

/** Keeps a free-text search safe to pass into a PostgREST ilike filter. */
export function sanitizeOperatorSearch(value: unknown) {
  if (typeof value !== 'string') return '';
  return value.replace(/[%_,()*\\]/g, '').trim().slice(0, 80);
}
