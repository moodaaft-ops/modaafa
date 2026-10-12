import { operationLabelAr } from '@/lib/ai/operation-labels';

type Totals = { cost: number; clicks: number; conversions: number; conversion_value: number };

function fmt(value: number, digits = 2) {
  return Number(value.toFixed(digits)).toLocaleString('en-US');
}

/**
 * The measured result of an executed change, as one sentence of business
 * memory. Fixed wording from the measurement numbers only: no model, so a
 * stored outcome can never carry an invented figure.
 */
export function outcomeFactText(
  actionType: string,
  createdAt: string | null,
  impact: { before: Totals; after: Totals }
) {
  const label = operationLabelAr(actionType) ?? 'تعديل';
  const date = createdAt ? createdAt.slice(0, 10) : 'تاريخ غير معروف';
  const { before, after } = impact;
  return (
    `${label} في ${date}: الصرف في 7 أيام من ${fmt(before.cost)} إلى ${fmt(after.cost)}، ` +
    `والتحويلات من ${fmt(before.conversions, 1)} إلى ${fmt(after.conversions, 1)}.`
  ).slice(0, 300);
}

/**
 * Best effort: a missing table (migration not run yet), a missing business or
 * a duplicate (unique on source_ref) is silently ignored. Never throws, so the
 * nightly measurement loop is never affected.
 */
export async function recordOutcomeFact(args: {
  supabase: any;
  accountId: string;
  actionId: string;
  actionType: string;
  createdAt: string | null;
  impact: { before: Totals; after: Totals };
}) {
  try {
    const { data: account } = await args.supabase
      .from('google_ads_accounts')
      .select('business_id')
      .eq('id', args.accountId)
      .maybeSingle();
    if (!account?.business_id) return;
    await args.supabase.from('business_memory').insert({
      business_id: account.business_id,
      account_id: args.accountId,
      kind: 'outcome',
      fact_ar: outcomeFactText(args.actionType, args.createdAt, args.impact),
      data: { action_id: args.actionId, action_type: args.actionType, before: args.impact.before, after: args.impact.after },
      source: 'action_outcome',
      source_ref: args.actionId,
      basis: 'measured',
    });
  } catch {
    // Memory is an extra; measurement already succeeded.
  }
}
