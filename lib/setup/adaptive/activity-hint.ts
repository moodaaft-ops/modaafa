import { moneyMetric } from '@/lib/google-ads/metrics';

/**
 * Whether the account spends, from what the platform already stored, for the
 * moment the live read of the account failed (`ClassifyInput.activityHint`).
 *
 * Without this a failed read classified the account «active» whatever it was,
 * so a customer with an empty account was offered the free audit (which spends
 * the one free quota on nothing). Only «nothing runs» changes the state; «it
 * spends» keeps the account active with no kind guessed, as before.
 *
 * Two sources, in this order:
 * 1. The 30-day spend the connect job read for this account (multi-account
 *    pick). Any spend is trusted whenever it was read; a ZERO is trusted only
 *    while the job is fresh, because campaigns may have started since.
 * 2. For an account the sync has run for, the campaigns it cached
 *    (`campaigns_cache`): no rows, or no cost in any stored metrics, means
 *    nothing runs. Same rule for staleness: «empty» only from a recent sync.
 *    Any cost is «spends» whatever the age of the sync.
 *
 * Anything else is null (unknown), and unknown changes nothing.
 */

/** A zero from the connect job is believed for this long. */
export const SPEND_ZERO_FRESH_HOURS = 48;
/** «No campaigns» from the sync is believed for this long. */
export const CACHE_EMPTY_FRESH_HOURS = 7 * 24;

export type CachedCampaignRow = {
  metrics_30d?: Record<string, unknown> | null;
  metrics_7d?: Record<string, unknown> | null;
};

export type ActivityHint = 'spends' | 'empty' | null;

function isRecent(at: string | Date | null | undefined, hours: number, now: Date): boolean {
  if (!at) return false;
  const time = at instanceof Date ? at.getTime() : Date.parse(at);
  return Number.isFinite(time) && now.getTime() - time <= hours * 3_600_000;
}

/** Pure. `cached` is null when the table could not be read. */
export function activityHintFrom(args: {
  /** customer_id → 30-day spend from the connect job; null when the job never read this account. */
  spend30: number | null;
  /** When the connect job finished (or started). */
  spendReadAt?: string | Date | null;
  /** google_ads_accounts.last_synced_at. */
  syncedAt?: string | null;
  cached: CachedCampaignRow[] | null;
  now?: Date;
}): ActivityHint {
  const now = args.now ?? new Date();

  if (typeof args.spend30 === 'number' && Number.isFinite(args.spend30)) {
    if (args.spend30 > 0) return 'spends';
    if (isRecent(args.spendReadAt, SPEND_ZERO_FRESH_HOURS, now)) return 'empty';
  }

  if (args.syncedAt && args.cached) {
    // A sync writes the cache only when every step succeeded, and a campaign with no activity in a window
    // keeps no metrics for it. So no rows, and rows with no cost, both say the account has not spent.
    const cost = args.cached.reduce(
      (sum, row) => sum + Math.max(moneyMetric(row?.metrics_30d ?? null, 'cost'), moneyMetric(row?.metrics_7d ?? null, 'cost')),
      0
    );
    if (cost > 0) return 'spends';
    return isRecent(args.syncedAt, CACHE_EMPTY_FRESH_HOURS, now) ? 'empty' : null;
  }
  return null;
}

/**
 * Reads the cached campaigns of the account through the caller's own RLS client
 * and applies `activityHintFrom`. Never throws; a failed read is unknown.
 */
export async function readActivityHint(
  supabase: any,
  args: {
    account: { id: string; last_synced_at?: string | null };
    spend30: number | null;
    spendReadAt?: string | Date | null;
    now?: Date;
  }
): Promise<ActivityHint> {
  const quick = activityHintFrom({ spend30: args.spend30, spendReadAt: args.spendReadAt, cached: null, now: args.now });
  if (quick === 'spends' || quick === 'empty') return quick;
  if (!args.account.last_synced_at) return null;
  try {
    const { data, error } = await supabase
      .from('campaigns_cache')
      .select('status, metrics_30d, metrics_7d')
      .eq('account_id', args.account.id)
      .limit(500);
    if (error || !Array.isArray(data)) return null;
    return activityHintFrom({
      spend30: args.spend30,
      spendReadAt: args.spendReadAt,
      syncedAt: args.account.last_synced_at,
      cached: data as CachedCampaignRow[],
      now: args.now,
    });
  } catch {
    return null;
  }
}
