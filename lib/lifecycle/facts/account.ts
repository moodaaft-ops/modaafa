import { partitionGoogleAdsAccounts, pickSelectedAdsAccount, type AdsAccountSummary } from '@/lib/accounts/selection';

/**
 * Which Google Ads account an email talks about. One rule, used by the fact
 * loader (lib/lifecycle/facts.ts, one person at send time) and by the planner's
 * batch read (lib/lifecycle/context.ts, many people), so the two can never
 * disagree about whose weekly report exists.
 *
 * It is the rule the app uses (lib/accounts/selection.getAccountWorkspace):
 * the user's newest business, its active non-manager accounts newest-linked
 * first, the persisted selected_google_ads_customer_id first, else the first
 * one. A cron has no cookie, so the cookie step is skipped.
 */
export const LIFECYCLE_ACCOUNT_STATUSES = ['active', 'revoked', 'paused'] as const;

/** `rows` must already be ordered newest-linked first. */
export function pickLifecycleAccount<T extends AdsAccountSummary>(rows: T[], persistedCustomerId: string | null): T | null {
  const { accounts } = partitionGoogleAdsAccounts(rows);
  return pickSelectedAdsAccount(accounts, null, persistedCustomerId) as T | null;
}
