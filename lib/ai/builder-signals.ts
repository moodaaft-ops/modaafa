import type { AccountSignals } from '@/lib/setup/adaptive/types';
import { loadLatestSignals } from '@/lib/setup/adaptive/signals-store';
import { UNKNOWN_BUILDER_SIGNALS, type BuilderAccountSignals } from './builder-gates';

/**
 * What the campaign builder may know about the account, from data the platform
 * already keeps: the synced campaign cache (conversions over 30 days) and the
 * stored onboarding read (conversion actions, auto-tagging, Merchant Center).
 * No Google call and no write. Anything missing stays `null`, and the gates in
 * builder-gates.ts treat `null` as the conservative option.
 */

/** Merchant Center and conversion actions change rarely; a week-old read still describes them. */
export const BUILDER_SIGNALS_MAX_AGE_HOURS = 7 * 24;

type CacheRow = { metrics_30d?: unknown };

function sumConversions(rows: CacheRow[] | null | undefined): number | null {
  if (!rows || rows.length === 0) return null;
  let total = 0;
  let seen = false;
  for (const row of rows) {
    const metrics = row?.metrics_30d as Record<string, unknown> | null | undefined;
    if (!metrics || typeof metrics !== 'object') continue;
    const conversions = Number(metrics.conversions ?? 0);
    if (!Number.isFinite(conversions)) continue;
    total += conversions;
    seen = true;
  }
  return seen ? Math.round(total * 1000) / 1000 : null;
}

function storedConversions(stored: AccountSignals | null): number | null {
  const campaigns = stored?.campaigns;
  if (!campaigns || !campaigns.ok) return null;
  return campaigns.value.reduce((sum, campaign) => sum + (Number.isFinite(campaign.conversions30) ? campaign.conversions30 : 0), 0);
}

/**
 * Pure: turns the two sources into the builder's signals.
 * Tracking is healthy only when conversions are arriving and no stored signal
 * contradicts it (titan 3.9: "تحويلات تصل" separates Max Clicks from Max Conversions).
 */
export function deriveBuilderSignals(args: {
  cacheRows: CacheRow[] | null | undefined;
  stored: AccountSignals | null;
}): BuilderAccountSignals {
  const { stored } = args;
  const conversions = sumConversions(args.cacheRows) ?? storedConversions(stored);

  let trackingHealthy: boolean | null = null;
  if (conversions !== null) {
    const actions = stored?.enabledConversionActions;
    const autoTagging = stored?.autoTagging;
    const contradicted =
      (actions?.ok === true && actions.value === 0) || (autoTagging?.ok === true && autoTagging.value === false);
    trackingHealthy = !contradicted && conversions > 0;
  }

  const merchant = stored?.merchantCenterLinked;
  return {
    conversions_30d: conversions,
    tracking_healthy: trackingHealthy,
    merchant_center_linked: merchant?.ok === true ? merchant.value : null,
  };
}

/** Loads the signals for one linked account row. Never throws; a failed read is "unknown". */
export async function loadBuilderSignals(args: {
  /** The caller's own RLS client (reads `campaigns_cache`). */
  supabase: any;
  /** The service client (reads `job_runs`); null when it could not be created. */
  admin: any | null;
  accountId: string;
}): Promise<BuilderAccountSignals> {
  try {
    const [cache, stored] = await Promise.all([
      Promise.resolve(
        args.supabase.from('campaigns_cache').select('metrics_30d').eq('account_id', args.accountId).limit(500)
      )
        .then((result: { data?: CacheRow[] | null; error?: unknown }) => (result?.error ? null : (result?.data ?? null)))
        .catch(() => null),
      args.admin
        ? loadLatestSignals(args.admin, args.accountId, { maxAgeHours: BUILDER_SIGNALS_MAX_AGE_HOURS })
        : Promise.resolve(null),
    ]);
    return deriveBuilderSignals({ cacheRows: cache, stored });
  } catch {
    return { ...UNKNOWN_BUILDER_SIGNALS };
  }
}
