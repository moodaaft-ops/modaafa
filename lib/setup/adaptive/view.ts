import { stripPlanCategories, withScenarioLead, type Plan } from '@/lib/plan/plan';
import type { SetupKey } from '../questions';
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
  EndingKind,
  Scenario,
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
  business: { name: string | null; monthlyBudget: number | null; targetRegions: string[]; website: string | null } | null;
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
 * were confirmed. So once `confirm` is «yes» those three count only when the
 * ledger itself holds them (a real `type` answer, a real `goal` answer), which
 * keeps the activity row sourced «أكدته» and still asks for the goal when the
 * account showed none.
 */
export function adaptiveAnswered(args: { answered: Answered; ledger: ReadonlyMap<string, string | null> }): Answered {
  const out: Answered = { ...args.answered };
  // The same holds when this chat wrote the sector through a `type` answer: the
  // screen re-plans after `type`, and the goal (asked in the kind's words for
  // new, dormant and no_account) must not vanish because the sector now exists.
  if (args.ledger.get('confirm') === 'yes' || args.ledger.has('type')) {
    for (const key of ['type', 'name', 'goal']) {
      if (!args.ledger.has(key)) delete out[key];
    }
  }
  return out;
}

const FRESH_STATES = new Set<Scenario['state']>(['new', 'dormant', 'no_account']);
const TRACKING_STATES = new Set<Scenario['state']>(['no_tracking', 'tracking_suspect']);

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

  const scenario = classifyScenario({ signals, linkedAccounts: input.linkedAccounts, connectNoAccount, answered });

  // --- which flow runs: an account to read, or the customer's «كمّل بدون حساب»
  const goesOnWithoutAccount = !input.accountChosen && input.linkedAccounts === 0 && answeredChoice(answered, 'has_account') === 'none';
  const withoutAccountFlow = goesOnWithoutAccount && !edit;
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
            ? { name: input.business.name, monthlyBudget: input.business.monthlyBudget, targetRegions: input.business.targetRegions }
            : null,
        })
      : [];

  const ending = endingFor(scenario);
  const currency = (signals?.currency ?? input.currency ?? input.plan?.currency ?? 'SAR').toUpperCase();

  // --- the rules decision, the plan the browser may see, and the words around them
  const decision = flowActive ? scenarioDecision({ scenario, signals, answered, currency }) : null;

  const auditDecisions = input.plan
    ? [...(input.plan.first ? [input.plan.first] : []), ...input.plan.locked].map((row) => ({
        title: row.title,
        category: row.category ?? null,
      }))
    : [];

  let plan = input.plan;
  if (plan) {
    if (decision) plan = withScenarioLead(plan);
    if (TRACKING_STATES.has(scenario.state)) plan = { ...plan, waste: null };
    plan = stripPlanCategories(plan);
  }

  const firstWhy =
    flowActive && !decision && input.plan?.first
      ? planReason({
          scenario,
          answered,
          labels,
          decision: { title: input.plan.first.title, category: input.plan.first.category ?? null },
        })
      : null;

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
  };
}

/** Which adaptive answers use a stored read or an earlier answer to word their reply. */
export const ANSWER_KEYS_NEEDING_SIGNALS: readonly string[] = ['push_products', 'aov_check', 'margin', 'close_rate'];
export const ANSWER_KEYS_NEEDING_LEDGER: readonly string[] = ['margin', 'close_rate'];
