import { moneyMetric } from '@/lib/google-ads/metrics';
import type { TrialTrack } from '../types';

/**
 * Which trial track a person is on, from what the platform already stored
 * about their linked Google Ads accounts.
 *
 * Track B = the accounts spent less than TRIAL_TRACK_B_SPEND_BELOW in the last
 * 30 days (the sum of `cost` in `campaigns_cache.metrics_30d`, read with
 * `moneyMetric` like every other spend figure in the codebase). Nothing runs,
 * so مُضاعِف has nothing to read and the trial mails help launch a first
 * campaign instead of reporting decisions. Track A = the account spends.
 *
 * Costs are compared as stored, in the account currency. The platform has no
 * currency conversion anywhere, and the audience is Saudi accounts in SAR.
 *
 * A low number is only believed when the cache is fresh: «below 300» from an
 * account that was last synced weeks ago says nothing about today (same rule
 * as lib/setup/adaptive/activity-hint.ts). Anything that cannot be settled is
 * `null`, and the copy then falls back to the track A texts.
 */
export const TRIAL_TRACK_B_SPEND_BELOW = 300;

/** «Spent little» is believed only from a sync this recent. */
export const SPEND_CACHE_FRESH_HOURS = 7 * 24;

export type CachedCostRow = { metrics_30d?: Record<string, unknown> | null };

export type TrialSpend = { spend30: number | null; track: TrialTrack | null };

function isRecent(at: string | null | undefined, hours: number, now: Date): boolean {
  if (!at) return false;
  const time = Date.parse(at);
  return Number.isFinite(time) && now.getTime() - time <= hours * 3_600_000;
}

/** Pure. `rows` is null when campaigns_cache could not be read. `syncedAt` has one entry per linked account. */
export function trialSpendFrom(args: {
  rows: CachedCostRow[] | null;
  syncedAt: Array<string | null | undefined>;
  now?: Date;
}): TrialSpend {
  const now = args.now ?? new Date();
  if (!args.rows) return { spend30: null, track: null };

  const spend30 = args.rows.reduce((sum, row) => sum + Math.max(0, moneyMetric(row?.metrics_30d ?? null, 'cost')), 0);
  if (spend30 >= TRIAL_TRACK_B_SPEND_BELOW) return { spend30, track: 'a' };
  if (args.syncedAt.some((at) => isRecent(at, SPEND_CACHE_FRESH_HOURS, now))) return { spend30, track: 'b' };
  return { spend30, track: null };
}
