import { googleAdsAccountNameMissing } from '@/lib/accounts/display';
import { getAccountWorkspace, getLinkedGoogleAdsAccount, getUserBusinessWithClient } from '@/lib/accounts/selection';
import { withProductTitles } from './adaptive/bank';
import { ensureSetupBusiness } from './adaptive/ensure-business';
import { confirmBusinessColumns, type AdaptiveReactionContext } from './adaptive/answers';
import { averageOrder } from './adaptive/shared';
import { loadStoredSignals } from './adaptive/signals-store';
import type { AccountSignals, AdaptiveAnswer } from './adaptive/types';
import { ANSWER_KEYS_NEEDING_LEDGER, ANSWER_KEYS_NEEDING_SIGNALS, reactionContextFor } from './adaptive/view';
import { readLedgerEntries } from './ledger';
import {
  GOAL_OPTIONS,
  NAME_MAX,
  PAIN_OPTIONS,
  cleanUserText,
  isAdaptiveKey,
  parseAnswer,
  type SetupAnswer,
} from './questions';
import { saveSetupAnswer, type SaveOutcome } from './save';

/**
 * The part of POST /api/setup/answer that decides things, kept out of the route
 * so each decision is a unit test with fakes: what the browser may send, what
 * only the server fills in, and what an answer writes beyond its own fact.
 */

const isAdaptiveAnswer = (answer: SetupAnswer): answer is AdaptiveAnswer => isAdaptiveKey(answer.key);

export type CheckedAnswer = { ok: true; answer: SetupAnswer } | { ok: false; status: 400 | 404; error: string };

/**
 * Validates the browser's key and value against the rules the screen uses.
 *
 * - The adaptive keys exist only for someone the tree is switched on for; for anyone else they are not here (404).
 * - Per-kind goal and pain ids (`clinic_calls`, `shop_few_orders` …) are the adaptive tree's words. Someone the
 *   tree is off for is shown the ten fixed questions, whose lists are GOAL_OPTIONS and PAIN_OPTIONS, so any other
 *   id is a choice the screen never offered and is refused like any unknown choice.
 */
export function checkSetupAnswer(body: Record<string, unknown> | null, adaptiveOn: boolean): CheckedAnswer {
  if (isAdaptiveKey(body?.key) && !adaptiveOn) return { ok: false, status: 404, error: 'not_found' };
  const parsed = parseAnswer(body?.key, body?.answer);
  if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
  if (!adaptiveOn) {
    const answer = parsed.answer;
    if (answer.key === 'goal' && !GOAL_OPTIONS.some((option) => option.id === answer.choice)) {
      return { ok: false, status: 400, error: 'invalid_choice' };
    }
    if (answer.key === 'pain' && !PAIN_OPTIONS.some((option) => option.id === answer.choice)) {
      return { ok: false, status: 400, error: 'invalid_choice' };
    }
  }
  return { ok: true, answer: parsed.answer };
}

type SetupUser = { id: string; email?: string | null; user_metadata?: Record<string, unknown> | null };

/**
 * True while `businesses.name` is still what the workspace was created with
 * (the login's name, the email's local part, or «نشاطي»), never a name the
 * customer typed. Compared case-insensitively on trimmed text.
 */
export function isFallbackBusinessName(name: string | null | undefined, user: SetupUser): boolean {
  const current = String(name ?? '').trim().toLowerCase();
  if (!current) return true;
  const meta = user.user_metadata ?? {};
  const candidates = [meta.full_name, meta.name, user.email ? user.email.split('@')[0] : null, 'نشاطي'];
  return candidates.some((candidate) => typeof candidate === 'string' && candidate.trim().toLowerCase() === current);
}

export type AnswerTarget = {
  business: { id: string; name?: string | null } | null;
  account: { id: string; customer_name?: string | null } | null;
};

/** For tests: how the workspace is read and made, which otherwise come from the request's cookies and database. */
export type AnswerTargetDeps = {
  workspace?: (userId: string) => Promise<{ business: AnswerTarget['business']; selectedAccount: AnswerTarget['account'] } | null>;
  ensureBusiness?: typeof ensureSetupBusiness;
};

/**
 * The business and the linked account an answer belongs to.
 *
 * - With the tree on, the account is the one the setup screen reads
 *   (`getAccountWorkspace`: the cookie's choice, else the persisted one, else the first). «ما عندي حساب
 *   إعلانات» comes before any Google link, so the workspace may not exist yet; only that one answer, and only
 *   with the tree on, makes it. Every other answer without a business stays a «no_business».
 * - With the tree off, exactly what the route always did: the newest business and its persisted account.
 */
export async function resolveAnswerTarget(args: {
  supabase: any;
  user: SetupUser;
  adaptiveOn: boolean;
  answer: SetupAnswer;
  deps?: AnswerTargetDeps;
}): Promise<AnswerTarget> {
  const { supabase, user, adaptiveOn, answer } = args;
  if (adaptiveOn) {
    const load = args.deps?.workspace ?? ((userId: string) => getAccountWorkspace(userId));
    const workspace = await load(user.id).catch(() => null);
    let business = workspace?.business ?? null;
    const account = workspace?.selectedAccount ?? null;
    if (!business && answer.key === 'has_account') {
      business = await (args.deps?.ensureBusiness ?? ensureSetupBusiness)(supabase, user);
    }
    return { business, account };
  }

  const legacy: { id: string; selected_google_ads_customer_id?: string | null } | null = await getUserBusinessWithClient(supabase, user.id).catch(() => null);
  const linked = legacy
    ? await getLinkedGoogleAdsAccount({
        supabase,
        userId: user.id,
        customerId: legacy.selected_google_ads_customer_id ?? '',
        select: 'id',
      }).catch(() => null)
    : null;
  return { business: legacy, account: (linked?.account as { id: string } | null | undefined) ?? null };
}

/**
 * What the newest «yes» on the opener wrote on the business, when that is still the newest confirm: the sector
 * and the goal of the kind and outcome it confirmed. A column the customer answered themselves (a `type` or
 * `goal` on record, which wrote it too) is not listed, so a stated type or goal is never wiped. Null when the
 * newest confirm is not a «yes».
 */
async function confirmedColumns(admin: any, businessId: string): Promise<{ sector?: string; primary_goal?: string } | null> {
  const ledger = await readLedgerEntries(admin, businessId);
  if (ledger.choices.get('confirm') !== 'yes') return null;
  const wrote = confirmBusinessColumns(ledger.confirmed?.kind, ledger.confirmed?.outcome);
  return {
    ...(wrote.sector && !ledger.choices.has('type') ? { sector: wrote.sector } : {}),
    ...(wrote.primary_goal && !ledger.choices.has('goal') ? { primary_goal: wrote.primary_goal } : {}),
  };
}

/**
 * Writes one validated answer.
 *
 * Adaptive answers get what only the server knows, never the browser: the
 * product titles behind the picked chips, the average order the stored read
 * reported (so the fact can say the number), and the reaction context. After a
 * «yes» on the opener, a workspace still named after the login takes the Google
 * Ads account's own name, so «اسم النشاط» is a business and not a person. After
 * a «no» that follows a «yes», the sector (and goal) that «yes» wrote are taken
 * back, so the guess does not stay on the business as if the customer said it.
 */
export async function recordSetupAnswer(args: {
  supabase: any;
  admin: any | null;
  user: SetupUser;
  adaptiveOn: boolean;
  business: { id: string; name?: string | null };
  /** The linked account the answer belongs to (`customer_name` is read for the name step). */
  account: { id: string; customer_name?: string | null } | null;
  answer: SetupAnswer;
}): Promise<SaveOutcome> {
  const { supabase, admin, user, adaptiveOn, business, account } = args;
  let answer = args.answer;
  let reactionContext: AdaptiveReactionContext | undefined;

  if (adaptiveOn && admin && isAdaptiveAnswer(answer) && ANSWER_KEYS_NEEDING_SIGNALS.includes(answer.key)) {
    const signals: AccountSignals | null = account ? await loadStoredSignals(admin, account.id) : null;
    if (answer.key === 'push_products') answer = withProductTitles(answer, signals);
    if (answer.key === 'aov_check') {
      const average = averageOrder(signals);
      if (average !== null) answer = { ...answer, amount: average, currency: signals?.currency };
    }
    const ledger = ANSWER_KEYS_NEEDING_LEDGER.includes(answer.key)
      ? (await readLedgerEntries(admin, business.id)).choices
      : new Map<string, string | null>();
    reactionContext = reactionContextFor({ answer: answer as AdaptiveAnswer, ledger, signals });
  }

  // A «no» after a «yes»: the sector and goal that «yes» wrote were the product's guess, not the customer's word.
  // What it wrote is read before the answer is saved, because saving replaces it as the newest confirm.
  const takeBack = adaptiveOn && admin && answer.key === 'confirm' && answer.choice === 'no' ? await confirmedColumns(admin, business.id) : null;

  const outcome = await saveSetupAnswer({
    supabase,
    admin,
    userId: user.id,
    businessId: business.id,
    accountId: account?.id ?? null,
    answer,
    reactionContext,
  });

  if (outcome.ok && takeBack) {
    for (const column of ['sector', 'primary_goal'] as const) {
      const wrote = takeBack[column];
      if (!wrote) continue;
      try {
        // Only while the column still holds exactly what the «yes» wrote.
        await supabase
          .from('businesses')
          .update({ [column]: null, updated_at: new Date().toISOString() })
          .eq('id', business.id)
          .eq('user_id', user.id)
          .eq(column, wrote);
      } catch {
        // The «no» is saved, and the tree already stops counting the guess as the customer's word.
      }
    }
  }

  if (
    outcome.ok &&
    adaptiveOn &&
    answer.key === 'confirm' &&
    answer.choice === 'yes' &&
    account &&
    !googleAdsAccountNameMissing(account) &&
    isFallbackBusinessName(business.name, user)
  ) {
    const name = cleanUserText(account.customer_name, NAME_MAX);
    if (name.length >= 2) {
      try {
        await supabase
          .from('businesses')
          .update({ name, updated_at: new Date().toISOString() })
          .eq('id', business.id)
          .eq('user_id', user.id);
      } catch {
        // The answer is saved; a name that stays the login's is not worth failing it.
      }
    }
  }
  return outcome;
}
