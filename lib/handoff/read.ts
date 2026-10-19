import { detectHandoff, type HandoffReason, type HandoffThresholds } from './rules';

export type HandoffRow = {
  account_id: string;
  reasons?: string[] | null;
  spend_30d_sar: number | string | null;
  policy_flagged_ads: number | null;
  evaluated_at: string;
  asked_at: string | null;
  handled_at: string | null;
};

/**
 * What to show now. The stored spend and policy count come from the optimizer
 * run; suspension and the merchant's request are live, so a suspended account
 * (which the optimizer skips) still gets the card.
 */
export function evaluateStoredHandoff(
  row: HandoffRow | null,
  live: { suspended: boolean; googleDisabled: boolean },
  thresholds?: HandoffThresholds
): { needed: boolean; reasons: HandoffReason[]; spend30dSar: number | null } {
  const spend = row?.spend_30d_sar === null || row?.spend_30d_sar === undefined ? null : Number(row.spend_30d_sar);
  const verdict = detectHandoff(
    {
      spend30dSar: spend !== null && Number.isFinite(spend) ? spend : null,
      suspended: live.suspended,
      googleDisabled: live.googleDisabled,
      policyFlaggedAds: row?.policy_flagged_ads ?? null,
      askedForHuman: Boolean(row?.asked_at && !row?.handled_at),
    },
    thresholds
  );
  return { ...verdict, spend30dSar: spend !== null && Number.isFinite(spend) ? spend : null };
}
