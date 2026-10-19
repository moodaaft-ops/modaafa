import { readCampaignEntries } from '@/lib/ai/optimizer-gates';
import type { HandoffInput } from './rules';

type Query = { query(gaql: string): Promise<any[]> };

const POLICY_GAQL = `SELECT ad_group_ad.resource_name FROM ad_group_ad
  WHERE ad_group_ad.policy_summary.approval_status = 'DISAPPROVED'
  AND ad_group_ad.status != 'REMOVED' LIMIT 50`;

/** Sum of the 30-day campaign cost out of the optimizer snapshot, in whole currency units. */
export function spend30dFromSnapshot(snapshot: { campaigns: any[] }): number | null {
  let micros = 0;
  let seen = false;
  for (const entry of readCampaignEntries(snapshot as any)) {
    if (!entry.last30d) continue;
    micros += entry.last30d.cost_micros;
    seen = true;
  }
  return seen ? micros / 1_000_000 : null;
}

export async function loadHandoffSignals(args: {
  customer: Query;
  snapshot: { campaigns: any[] };
  currencyCode?: string | null;
  suspended: boolean;
  googleStatus?: string | null;
  accountStatus?: string | null;
}): Promise<HandoffInput> {
  let policyFlaggedAds: number | null = null;
  try {
    policyFlaggedAds = (await args.customer.query(POLICY_GAQL)).length;
  } catch {
    policyFlaggedAds = null;
  }
  // The threshold is in SAR. Another currency is not converted on a guess.
  const spend = String(args.currencyCode ?? 'SAR').toUpperCase() === 'SAR' ? spend30dFromSnapshot(args.snapshot) : null;
  const status = typeof args.googleStatus === 'string' ? args.googleStatus.toUpperCase() : null;
  return {
    spend30dSar: spend,
    suspended: args.suspended,
    googleDisabled:
      args.accountStatus === 'paused' ||
      Boolean(status && !['ENABLED', 'UNKNOWN', 'UNSPECIFIED'].includes(status)),
    policyFlaggedAds,
    askedForHuman: false,
  };
}
