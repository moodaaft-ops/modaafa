import type { AdaptiveReactionContext } from './adaptive/answers';
import { answerEffects, answerLabel, reactionTo, type SetupAnswer } from './questions';

export type SaveOutcome =
  | { ok: true; label: string; reaction: string | null; memorySaved: boolean }
  | { ok: false; error: 'save_failed' };

/**
 * Writes one setup answer.
 *
 * 1. The matching `businesses` column, through the caller's RLS client and
 *    scoped to their own row. A failure here fails the answer: it is what
 *    the audit and the optimizer read.
 * 2. One `business_memory` fact (service role, scoped to the business id the
 *    caller proved they own). The previous answer to the same question is
 *    marked superseded first, so the brain never reads two goals. A failure
 *    here keeps the answer: the brain loses one fact, the customer loses nothing.
 */
export async function saveSetupAnswer(args: {
  supabase: any;
  admin: any | null;
  userId: string;
  businessId: string;
  accountId: string | null;
  answer: SetupAnswer;
  /** What only the server knows (the account's average order, an earlier answer); sharpens the adaptive reactions. */
  reactionContext?: AdaptiveReactionContext;
}): Promise<SaveOutcome> {
  const effects = answerEffects(args.answer);

  if (Object.keys(effects.business).length > 0) {
    const { error } = await args.supabase
      .from('businesses')
      .update({ ...effects.business, updated_at: new Date().toISOString() })
      .eq('id', args.businessId)
      .eq('user_id', args.userId);
    if (error) return { ok: false, error: 'save_failed' };
  }

  let memorySaved = false;
  if (effects.fact && args.admin) {
    try {
      await args.admin
        .from('business_memory')
        .update({ status: 'superseded', updated_at: new Date().toISOString() })
        .eq('business_id', args.businessId)
        .eq('source', 'onboarding')
        .eq('status', 'active')
        .eq('data->>setup_key', args.answer.key);
      const { error } = await args.admin.from('business_memory').insert({
        business_id: args.businessId,
        account_id: args.accountId,
        kind: effects.fact.kind,
        fact_ar: effects.fact.fact_ar.slice(0, 300),
        data: effects.fact.data,
        source: 'onboarding',
        source_ref: `setup:${args.answer.key}`,
        basis: 'stated',
      });
      memorySaved = !error;
    } catch {
      memorySaved = false;
    }
  }

  return { ok: true, label: answerLabel(args.answer), reaction: reactionTo(args.answer, args.reactionContext), memorySaved };
}
