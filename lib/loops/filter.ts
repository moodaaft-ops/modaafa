/**
 * Deterministic filters the optimizer cron runs on the model's proposals when
 * the loop switches are on. Pure. With every switch off nothing is dropped and
 * the same array comes back.
 */

import { suppressNegativeRepeats, SUPPRESSED_BY_OUTCOME, type OutcomeRecord } from './outcome-memory';
import { merchantContextRejection, type MerchantFact } from './merchant-context';
import { seasonRejection, type SeasonContext } from './seasons';

export type LoopsContext = {
  outcomes: readonly OutcomeRecord[] | null;
  season: SeasonContext | null;
  merchantFacts: readonly MerchantFact[] | null;
  today: string;
};

export const EMPTY_LOOPS_CONTEXT: LoopsContext = { outcomes: null, season: null, merchantFacts: null, today: '' };

export const LOOP_REJECTION_REASON_AR: Record<string, string> = {
  [SUPPRESSED_BY_OUTCOME]: 'جربنا نفس التعديل على نفس العنصر قبل، وقسنا أثره وطلع سلبي، فما نكرره',
  season_week: 'آخر 7 أيام داخل موسم أو بعده مباشرة، وما نخفض الميزانية أو نوقف حملة بسبب تذبذب موسمي',
  merchant_stock_out: 'ذكرت إن المخزون خلص، فما نرفع الصرف الحين',
  merchant_offer_week: 'عندك عرض شغال أو جاي قريب، فما نخفض الميزانية ولا نوقف حملة الحين',
};

export type LoopAction = { type: string; target_id?: string; params?: Record<string, unknown> | null };

export type LoopDrop<T> = { action: T; code: string; reason_ar: string };

export function applyLoopFilters<T extends LoopAction>(
  actions: readonly T[],
  context: LoopsContext
): { kept: T[]; dropped: Array<LoopDrop<T>> } {
  const dropped: Array<LoopDrop<T>> = [];
  let kept: T[] = [...actions];

  if (context.outcomes && context.outcomes.length > 0) {
    const split = suppressNegativeRepeats(kept, context.outcomes);
    kept = split.kept;
    for (const item of split.suppressed) {
      dropped.push({ action: item.action, code: SUPPRESSED_BY_OUTCOME, reason_ar: LOOP_REJECTION_REASON_AR[SUPPRESSED_BY_OUTCOME] });
    }
  }

  const stillKept: T[] = [];
  for (const action of kept) {
    const code =
      seasonRejection(action, context.season) ??
      (context.merchantFacts ? merchantContextRejection(action, context.merchantFacts, context.today) : null);
    if (code) dropped.push({ action, code, reason_ar: LOOP_REJECTION_REASON_AR[code] });
    else stillKept.push(action);
  }
  return { kept: stillKept, dropped };
}
