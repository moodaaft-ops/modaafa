import { stripPlanCategories, withScenarioLead, type Plan } from '@/lib/plan/plan';
import { TYPE_OPTIONS, keysAnsweredByProfile, type BusinessProfile, type SetupKey } from '../questions';
import { resolveSetupStage, type SetupStage } from '../stage';
import type { AdaptiveReactionContext } from './answers';
import { adaptivePending, adaptiveQuestion } from './bank';
import { planReason, scenarioDecision } from './decisions';
import { AGENCY_FULL_MANAGEMENT_CARD, agencyQuestions, firstCampaignPlan } from './endings';
import { buildOpener } from './opener';
import { classifyScenario } from './scenario';
import { answeredChoice, averageOrder } from './shared';
import { canReuseStoredSignals } from './signals-store';
import { understandingRows } from './understanding';
import type {
  AccountSignals,
  AdaptiveAnswer,
  AdaptiveQuestion,
  AdaptiveView,
  BusinessKind,
  DominantOutcome,
  EndingKind,
  Scenario,
  ScenarioDecision,
} from './types';

type Answered = Partial<Record<string, string | null>>;

export type AdaptiveViewInput = {
  /** The stored read of the chosen account, or null (never read, expired, or no account). */
  signals: AccountSignals | null;
  /** Linked, non-manager, active accounts. */
  linkedAccounts: number;
  /** An account is linked and chosen (several accounts: the customer picked one). */
  accountChosen: boolean;
  /** Several accounts linked and none picked yet. */
  needsChoice: boolean;
  /** The connect job is running right now. */
  connectRunning: boolean;
  /** The connect job's error code (`no_accounts` and `no_client_accounts` mean «nothing to connect»). */
  connectError: string | null;
  /**
   * Answers on record: ledger choice ids, plus the keys the old business form
   * already answers (choice null). Build it with `adaptiveAnswered`.
   */
  answered: Answered;
  /** The words the customer saw when they answered (`data.label` of each ledger fact). */
  labels: Partial<Record<string, string>>;
  business: { name: string | null; monthlyBudget: number | null; targetRegions: string[]; website: string | null; sector?: string | null } | null;
  consentAnswered: boolean;
  edit: boolean;
  firstName: string | null;
  /** An audit is on record for the chosen account. */
  auditExists: boolean;
  subscriptionActive: boolean;
  /** «خطتك جاهزة» as loaded with `includeCategory`, or null. */
  plan: Plan | null;
  /** The chosen account's currency; the stored read's own wins when there is one. */
  currency?: string | null;
  /** What the platform knows about the account's activity when the read failed (see ClassifyInput). Null when unknown. */
  activityHint?: 'spends' | 'empty' | null;
  /** The kind the customer agreed with on the opener, from the ledger (see ClassifyInput). */
  confirmed?: { kind: BusinessKind; outcome: DominantOutcome | null } | null;
  /** For tests: the clock the stored read's age is judged by. */
  now?: Date;
};

export type AdaptiveViewResult = {
  view: AdaptiveView;
  pending: SetupKey[];
  stage: SetupStage;
  /** The plan the browser may see: rules lead applied, no waste for no-tracking states, no audit categories. */
  plan: Plan | null;
};

/**
 * The answers the adaptive tree reads. The opener's «إي صح» writes
 * `businesses.sector` and `primary_goal`, and the old-form rule would then count
 * `type`, `name` and `goal` as answered by the customer. They were not: they
 * were confirmed. So once `confirm` is on record (yes, or a later no that
 * replaced it: the sector an earlier yes wrote stays on the business) those three
 * count only when the ledger itself holds them (a real `type` answer, a real
 * `goal` answer), which keeps the activity row sourced «أكدته» and still asks
 * for the goal when the account showed none. The kind the customer agreed with
 * is read from the ledger (`LedgerEntries.confirmed`), not from the sector.
 */
export function adaptiveAnswered(args: { answered: Answered; ledger: ReadonlyMap<string, string | null> }): Answered {
  const out: Answered = { ...args.answered };
  // The same holds when this chat wrote the sector through a `type` answer: the
  // screen re-plans after `type`, and the goal (asked in the kind's words for
  // new, dormant and no_account) must not vanish because the sector now exists.
  // A «no» on the opener counts the same way: the sector an earlier «yes» wrote is not the customer's word either.
  if (args.ledger.has('confirm') || args.ledger.has('type')) {
    for (const key of ['type', 'name', 'goal']) {
      if (!args.ledger.has(key)) delete out[key];
    }
  }
  return out;
}

/**
 * Every setup answer on record for a business, as the setup screen and the plan
 * lock both read it: the keys the old six-field form already answers (choice
 * null), a stored sector that matches a type label (its id), and the ledger's
 * own choice ids on top. Pass the result through `adaptiveAnswered` before the
 * adaptive rules read it.
 */
export function answeredOnRecord(args: {
  business: BusinessProfile | null;
  ledger: ReadonlyMap<SetupKey, string | null>;
}): Partial<Record<SetupKey, string | null>> {
  const answered: Partial<Record<SetupKey, string | null>> = {};
  for (const key of keysAnsweredByProfile(args.business)) answered[key] = null;
  // The old form stored a free sector; when it matches a type label, edit mode can mark it.
  const typeFromSector = TYPE_OPTIONS.find((option) => option.label === args.business?.sector?.trim())?.id;
  if (typeFromSector) answered.type = typeFromSector;
  for (const [key, choice] of args.ledger) answered[key] = choice;
  return answered;
}

const FRESH_STATES = new Set<Scenario['state']>(['new', 'dormant', 'no_account']);
const TRACKING_STATES = new Set<Scenario['state']>(['no_tracking', 'tracking_suspect']);

/** The two states where the account spends but cannot say what the ads bring: no waste number, no amount on any finding. */
export function isTrackingState(state: Scenario['state']): boolean {
  return TRACKING_STATES.has(state);
}

/**
 * «خطتك جاهزة» as the browser may see it once the tree has classified the
 * account: the rules decision (if any) takes the open slot and the audit's first
 * decision moves into the locked list, a tracking state shows no waste number,
 * and no decision carries its audit category. `firstWhy` is «ليش أول شي» for the
 * audit's own first decision, only when no rules decision took its place. One
 * place, so the setup screen, /home, /optimizer and /audit say the same thing.
 */
export function scenarioLead(args: {
  scenario: Scenario;
  signals: AccountSignals | null;
  answered: Answered;
  labels: Partial<Record<string, string>>;
  currency: string;
  /** The plan as loaded with `includeCategory`, or null. */
  plan: Plan | null;
  /** False when there is no account flow to speak for (no rules decision, no «ليش أول شي»). */
  active: boolean;
}): { plan: Plan | null; decision: ScenarioDecision | null; firstWhy: string | null } {
  const { scenario, signals, answered, labels, currency, active } = args;
  const decision = active ? scenarioDecision({ scenario, signals, answered, currency }) : null;

  let plan = args.plan;
  if (plan) {
    if (decision) plan = withScenarioLead(plan);
    if (TRACKING_STATES.has(scenario.state)) plan = { ...plan, waste: null };
    plan = stripPlanCategories(plan);
  }

  const firstWhy =
    active && !decision && args.plan?.first
      ? planReason({
          scenario,
          answered,
          labels,
          decision: { title: args.plan.first.title, category: args.plan.first.category ?? null },
        })
      : null;
  return { plan, decision, firstWhy };
}

/** The ending the screen shows after «فهمت عليك». */
export function endingFor(scenario: Pick<Scenario, 'state' | 'managed'>): EndingKind {
  if (FRESH_STATES.has(scenario.state)) return 'first_campaign';
  if (scenario.managed === 'confirmed') return 'agency';
  if (TRACKING_STATES.has(scenario.state)) return 'tracking';
  return 'plan';
}

/**
 * Everything the setup screen needs from the adaptive tree, on the server. The
 * raw signals never leave: only `view` goes to the browser. Pure and
 * synchronous (no clock but `now`, no network), so every branch is a unit test.
 */
export function buildAdaptiveView(input: AdaptiveViewInput): AdaptiveViewResult {
  const { answered, labels, edit } = input;
  const signals = input.accountChosen ? input.signals : null;
  const connectNoAccount = input.connectError === 'no_accounts' || input.connectError === 'no_client_accounts';

  const scenario = classifyScenario({
    signals,
    linkedAccounts: input.linkedAccounts,
    connectNoAccount,
    answered,
    activityHint: input.activityHint ?? null,
    confirmed: input.confirmed ?? null,
  });

  // --- which flow runs: an account to read, or the customer's «كمّل بدون حساب» (editing it too: «عدّل شي» must open the questions)
  const withoutAccountFlow = !input.accountChosen && input.linkedAccounts === 0 && answeredChoice(answered, 'has_account') === 'none';
  const flowActive = input.accountChosen || withoutAccountFlow;

  let pending: SetupKey[] = [];
  if (input.accountChosen) {
    pending = adaptivePending({ scenario, answered, consentAnswered: input.consentAnswered, edit, hasAccount: true });
  } else if (withoutAccountFlow) {
    pending = adaptivePending({ scenario, answered, consentAnswered: input.consentAnswered, edit, hasAccount: false });
  }

  // --- stage: today's rule first, then the three overrides
  let stage = resolveSetupStage({
    linkedAccounts: input.linkedAccounts,
    connectRunning: input.connectRunning,
    needsChoice: input.needsChoice,
    pending,
    auditExists: input.auditExists,
    edit,
  });
  if (!input.connectRunning) {
    if (withoutAccountFlow) {
      // There is no home without an account: never «done».
      stage = pending.length > 0 ? 'questions' : 'finishing';
    } else if (input.accountChosen && !edit && pending.length === 0 && (scenario.state === 'new' || scenario.state === 'dormant')) {
      // No audit runs for these, so the first-campaign plan is the way out.
      stage = input.subscriptionActive ? 'done' : 'finishing';
    }
  }

  const needsRead = input.accountChosen && !edit && !canReuseStoredSignals(signals, input.now);

  const opener = !edit && pending.includes('confirm') ? buildOpener(scenario, signals, { firstName: input.firstName }) : null;

  const questions: Partial<Record<string, AdaptiveQuestion>> = {};
  for (const key of pending) {
    const question = adaptiveQuestion(key, { scenario, signals, answered, edit });
    if (question) questions[key] = question;
  }

  const understood =
    flowActive && !edit && pending.length === 0
      ? understandingRows({
          scenario,
          signals,
          answered,
          labels,
          business: input.business
            ? {
                name: input.business.name,
                monthlyBudget: input.business.monthlyBudget,
                targetRegions: input.business.targetRegions,
                sector: input.business.sector ?? null,
              }
            : null,
        })
      : [];

  const ending = endingFor(scenario);
  const currency = (signals?.currency ?? input.currency ?? input.plan?.currency ?? 'SAR').toUpperCase();

  // --- the rules decision, the plan the browser may see, and the words around them
  const { plan, decision, firstWhy } = scenarioLead({
    scenario,
    signals,
    answered,
    labels,
    currency,
    plan: input.plan,
    active: flowActive,
  });

  const auditDecisions = input.plan
    ? [...(input.plan.first ? [input.plan.first] : []), ...input.plan.locked].map((row) => ({
        title: row.title,
        category: row.category ?? null,
      }))
    : [];

  const firstCampaign = flowActive
    ? firstCampaignPlan({
        scenario,
        answered,
        labels,
        business: input.business
          ? { monthlyBudget: input.business.monthlyBudget, targetRegions: input.business.targetRegions, website: input.business.website }
          : null,
        currency,
      })
    : null;

  const view: AdaptiveView = {
    scenario: {
      state: scenario.state,
      managed: scenario.managed,
      kind: scenario.kind,
      kindConfidence: scenario.kindConfidence,
      platform: scenario.platform,
      specialty: scenario.specialty,
      outcome: scenario.outcome,
    },
    needsRead,
    opener,
    questions,
    understood,
    ending,
    // The state comes from the read or, when the read failed, from the activity hint; with neither it
    // stays «active» (today's behavior), which is the one case a free audit can still run on an empty account.
    auditAllowed: scenario.state === 'active' || TRACKING_STATES.has(scenario.state),
    decision,
    firstWhy,
    firstCampaign,
    agencyQuestions: ending === 'agency' ? agencyQuestions(auditDecisions) : [],
    fullManagementCard: AGENCY_FULL_MANAGEMENT_CARD && ending === 'agency',
  };

  return { view, pending, stage, plan };
}

/**
 * What `reactionTo` may use that only the server knows. The account's average
 * order counts only when the customer agreed with it (`aov_check` «same», on
 * record or in this very answer), because a corrected number is not the
 * account's anymore.
 */
export function reactionContextFor(args: {
  answer: AdaptiveAnswer;
  ledger: ReadonlyMap<string, string | null>;
  signals: AccountSignals | null;
}): AdaptiveReactionContext {
  const { answer, ledger, signals } = args;
  const agreed = answer.key === 'aov_check' ? answer.choice === 'same' : ledger.get('aov_check') === 'same';
  return {
    aov: agreed ? averageOrder(signals) : null,
    currency: signals?.currency ?? null,
    dealValue: ledger.get('deal_value') ?? null,
    profit: ledger.get('profit_per_deal') ?? null,
  };
}

/** Which adaptive answers use a stored read or an earlier answer to word their reply. */
export const ANSWER_KEYS_NEEDING_SIGNALS: readonly string[] = ['push_products', 'aov_check', 'margin', 'close_rate'];
export const ANSWER_KEYS_NEEDING_LEDGER: readonly string[] = ['margin', 'close_rate'];
