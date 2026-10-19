import { detectHandoff, type HandoffInput, type HandoffThresholds } from './rules';

/**
 * Re-evaluate one account and keep the row current. asked_at and handled_at are
 * never touched here, so a merchant's request survives the next evaluation.
 * Best effort: the optimizer never waits on, or fails because of, this.
 */
export async function refreshHandoff(args: {
  admin: any;
  accountId: string;
  input: HandoffInput;
  thresholds?: HandoffThresholds;
  now?: Date;
}) {
  try {
    const verdict = detectHandoff({ ...args.input, askedForHuman: false }, args.thresholds);
    const { error } = await args.admin.from('agency_handoffs').upsert(
      {
        account_id: args.accountId,
        reasons: verdict.reasons.map((reason) => reason.code),
        spend_30d_sar: args.input.spend30dSar,
        policy_flagged_ads: args.input.policyFlaggedAds,
        evaluated_at: (args.now ?? new Date()).toISOString(),
      },
      { onConflict: 'account_id' }
    );
    if (error) console.error('Handoff refresh failed', error.message);
    return verdict;
  } catch (error) {
    console.error('Handoff refresh failed', error instanceof Error ? error.message : error);
    return null;
  }
}

export async function recordHandoffRequest(admin: any, accountId: string, now = new Date()) {
  const iso = now.toISOString();
  const { data: existing, error: readError } = await admin
    .from('agency_handoffs')
    .select('account_id')
    .eq('account_id', accountId)
    .maybeSingle();
  if (readError) throw readError;
  if (existing) {
    const { error } = await admin
      .from('agency_handoffs')
      .update({ asked_at: iso, handled_at: null, handled_by: null })
      .eq('account_id', accountId);
    if (error) throw error;
    return;
  }
  const { error } = await admin
    .from('agency_handoffs')
    .insert({ account_id: accountId, reasons: [], asked_at: iso, evaluated_at: iso });
  if (error) throw error;
}
