import { categoryForActionType, normalizeShadowCategory, type ShadowVerdict } from './summary';

type ShadowCard = {
  type: string;
  target_id?: string | null;
  params?: Record<string, unknown> | null;
  reason_ar?: string | null;
  confidence?: number | null;
  expected_impact?: unknown;
};

/**
 * Store what the optimizer would have done. Writes ONLY to shadow_decisions
 * (executable is forced false by a CHECK). Nothing is written to
 * recommendations, so no approval or execution path can see these.
 */
export async function recordShadowDecisions(args: {
  admin: any;
  accountId: string;
  jobRunId?: string | null;
  cards: ShadowCard[];
}) {
  if (args.cards.length === 0) return { stored: 0 };
  const rows = args.cards.map((card) => ({
    account_id: args.accountId,
    job_run_id: args.jobRunId ?? null,
    action_type: String(card.type),
    category: categoryForActionType(String(card.type)),
    target_id: card.target_id ? String(card.target_id) : null,
    action: { params: card.params ?? {}, expected_impact: card.expected_impact ?? null },
    reason_ar: card.reason_ar ? String(card.reason_ar).slice(0, 600) : null,
    confidence: typeof card.confidence === 'number' && Number.isFinite(card.confidence) ? card.confidence : null,
    executable: false,
  }));
  const { error } = await args.admin.from('shadow_decisions').insert(rows);
  if (error) {
    console.error('Shadow decisions not stored', error.message);
    return { stored: 0 };
  }
  return { stored: rows.length };
}

export async function markShadowAccount(admin: any, accountId: string, operatorId: string, note?: string | null) {
  const { error } = await admin
    .from('shadow_accounts')
    .upsert({ account_id: accountId, marked_by: operatorId, note: note?.slice(0, 300) ?? null }, { onConflict: 'account_id' });
  if (error) throw error;
}

export async function unmarkShadowAccount(admin: any, accountId: string) {
  const { error } = await admin.from('shadow_accounts').delete().eq('account_id', accountId);
  if (error) throw error;
}

export async function saveShadowReview(args: {
  admin: any;
  accountId: string;
  decisionId: string | null;
  verdict: ShadowVerdict;
  category?: string | null;
  note?: string | null;
  reviewerId: string;
}) {
  const note = args.note?.trim().slice(0, 600) || null;
  if (args.verdict === 'missed') {
    const { error } = await args.admin.from('shadow_reviews').insert({
      account_id: args.accountId,
      decision_id: null,
      verdict: 'missed',
      category: normalizeShadowCategory(args.category),
      note,
      reviewed_by: args.reviewerId,
    });
    if (error) throw error;
    return;
  }
  if (!args.decisionId) throw new Error('decision_required');
  const { data: decision, error: readError } = await args.admin
    .from('shadow_decisions')
    .select('id, account_id, category')
    .eq('id', args.decisionId)
    .maybeSingle();
  if (readError) throw readError;
  if (!decision || decision.account_id !== args.accountId) throw new Error('decision_not_found');
  const { error } = await args.admin.from('shadow_reviews').upsert(
    {
      account_id: args.accountId,
      decision_id: args.decisionId,
      verdict: args.verdict,
      category: normalizeShadowCategory(decision.category),
      note,
      reviewed_by: args.reviewerId,
      created_at: new Date().toISOString(),
    },
    { onConflict: 'decision_id' }
  );
  if (error) throw error;
}
