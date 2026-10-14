import type { Plan } from '@/lib/plan/plan';
import type { SetupState } from '@/lib/setup/load';
import type { SetupKey } from '@/lib/setup/questions';
import type { AdaptiveOption, BusinessKind, DominantOutcome, UnderstoodRow } from '@/lib/setup/adaptive/types';

/**
 * The small decisions of the adaptive setup screen that need no React, so they
 * can be tested on their own. Everything here is only ever reached when
 * `state.adaptive` is non-null; the legacy flow never calls it.
 */

/** What a dock hands back: the payload for the API and the words for the customer's bubble. */
export type AdaptivePayload = { answer: Record<string, unknown> & { choice?: string }; label: string };

/** The exclusive «لا، كلها سوا» option of the product chips: it is sent alone and never ticked with products. */
export const EXCLUSIVE_OPTION_ID = 'none';

/** After one of these the answer changes the tree, so the screen asks the server for the new list of questions. */
export const REPLAN_KEYS: readonly SetupKey[] = ['confirm', 'type', 'manager', 'has_account'];

export function changesTree(key: SetupKey): boolean {
  return REPLAN_KEYS.includes(key);
}

/**
 * The questions still to ask after a re-plan. Outside edit mode the server's
 * `pending` already leaves out everything answered. In edit mode it lists every
 * key again (the old answers are only marked), so the keys already asked in
 * this session are dropped, or the customer would be asked them twice.
 */
export function replannedQueue(args: {
  pending: readonly SetupKey[];
  answeredNow: SetupKey;
  asked: readonly SetupKey[];
  edit: boolean;
}): SetupKey[] {
  const done = new Set<SetupKey>([args.answeredNow, ...(args.edit ? args.asked : [])]);
  return args.pending.filter((key, index) => args.pending.indexOf(key) === index && !done.has(key));
}

/**
 * May the free audit start? Only the adaptive states that spend (auditAllowed),
 * never while editing, never with one on record, and not before the type and
 * the opener's «صح؟» are settled (they can change what the audit is about).
 */
export function shouldStartAudit(state: SetupState): boolean {
  const adaptive = state.adaptive;
  if (!adaptive || !adaptive.auditAllowed) return false;
  if (state.edit || state.audit) return false;
  return !state.pending.includes('type') && !state.pending.includes('confirm');
}

/** The audit may be run or retried at all: always on the legacy path, only for states that spend on the adaptive one. */
export function auditPermitted(state: SetupState): boolean {
  return !state.adaptive || state.adaptive.auditAllowed;
}

// ---------------------------------------------------------------------------
// Answer payloads (the shapes parseAdaptiveAnswer accepts)
// ---------------------------------------------------------------------------

export function optionPayload(option: AdaptiveOption): AdaptivePayload {
  return { answer: { choice: option.id }, label: option.label };
}

/** «yes» carries the kind and outcome the opener proposed, so the server can write them as stated facts. */
export function confirmPayload(
  option: AdaptiveOption,
  proposal: { kind: BusinessKind; outcome: DominantOutcome } | null
): AdaptivePayload {
  if (option.id === 'yes' && proposal) {
    return { answer: { choice: 'yes', kind: proposal.kind, outcome: proposal.outcome }, label: option.label };
  }
  return optionPayload(option);
}

/** What typing instead of tapping sends, by key. */
export function freeTextPayload(key: string, text: string): AdaptivePayload {
  switch (key) {
    case 'exclude_products':
      return { answer: { choice: 'text', text }, label: text };
    case 'push_products':
      return { answer: { choices: [], text }, label: text };
    default:
      // focus_service and type: «غير كذا» with the words.
      return { answer: { choice: 'other', text }, label: text };
  }
}

/** The ticked chips (and any typed name) as one answer. */
export function chipsPayload(picked: readonly AdaptiveOption[], text: string): AdaptivePayload {
  const ids = picked.map((option) => option.id);
  const typed = text.trim();
  return {
    answer: { ...(ids.length > 0 ? { choice: ids[0] } : {}), choices: ids, ...(typed ? { text: typed } : {}) },
    label: [...picked.map((option) => option.label), ...(typed ? [typed] : [])].join('، '),
  };
}

export function toggleId(selected: readonly string[], id: string): string[] {
  return selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id];
}

// ---------------------------------------------------------------------------
// Words on the cards
// ---------------------------------------------------------------------------

/** The small tag after each «فهمت عليك» value. */
export const SOURCE_TAG: Record<UnderstoodRow['source'], string> = {
  account: 'من حسابك',
  confirmed: 'أكدته',
  you: 'قلته',
};

/**
 * The sentence under «خطتك جاهزة» for an account somebody else manages. The
 * plain one-decision sentence speaks of «التنفيذ», which this ending never
 * offers, so that case gets its own words. Null keeps the card's own sentence.
 */
export function agencyPlanSubtitle(plan: Pick<Plan, 'kind' | 'decisionsCount' | 'locked'>, hasLead: boolean, trialEligible: boolean): string | null {
  const count = hasLead ? plan.locked.length + 1 : plan.decisionsCount;
  if (count !== 1 || (plan.kind !== 'ready' && !hasLead)) return null;
  const opens = trialEligible ? 'تجربتك المجانية' : 'اشتراكك';
  return `فحصت حسابك وطلع لك قرار واحد، وهو قدامك. والمحادثة تنفتح مع ${opens}.`;
}
