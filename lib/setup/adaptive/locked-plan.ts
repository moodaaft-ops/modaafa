import { stripPlanCategories, type Plan } from '@/lib/plan/plan';
import { readLedgerEntries, type LedgerEntries } from '../ledger';
import type { BusinessProfile } from '../questions';
import { classifyScenario } from './scenario';
import { LATEST_SIGNALS_MAX_AGE_HOURS, loadLatestSignals } from './signals-store';
import type { AccountSignals, ScenarioDecision } from './types';
import { adaptiveAnswered, answeredOnRecord, scenarioLead } from './view';

/**
 * The plan lock outside the onboarding screen.
 *
 * «خطتك جاهزة» on /home, /optimizer and /audit used to be rebuilt from the audit
 * alone, which undid what the onboarding screen had just shown: the audit's
 * first decision open again beside (or instead of) the rules decision, and a
 * waste number for an account that cannot say what its ads bring. This applies
 * the same rules the setup screen applies, to the newest stored read of the
 * account (up to 30 days old) and the customer's answers.
 *
 * Only for someone the adaptive tree is switched on for (the caller checks
 * `isAdaptiveOnboarding`). With no usable read the plan comes back as it was,
 * categories stripped, and `lead` and `firstWhy` are null: everything stays as
 * it is today.
 */
export type AdaptiveLockedPlan = {
  /** The plan the browser may see: rules lead applied, no waste for a tracking state, no audit category anywhere. */
  plan: Plan;
  /** A decision found by rules, shown open in place of the audit's first one. */
  lead: ScenarioDecision | null;
  /** «ليش أول شي» under the audit's own first decision, when there is no lead. */
  firstWhy: string | null;
};

/** Pure. `plan` must have been loaded with `includeCategory`; the rules read each decision's category here and it is gone from the result. */
export function applyAdaptiveLock(args: {
  plan: Plan;
  /** The newest stored read of the account within `LATEST_SIGNALS_MAX_AGE_HOURS`, or null. */
  signals: AccountSignals | null;
  ledger: LedgerEntries;
  business: BusinessProfile | null;
  currency?: string | null;
}): AdaptiveLockedPlan {
  const { plan, signals, ledger, business } = args;
  if (!signals) return { plan: stripPlanCategories(plan), lead: null, firstWhy: null };

  const answered = adaptiveAnswered({ answered: answeredOnRecord({ business, ledger: ledger.choices }), ledger: ledger.choices });
  const scenario = classifyScenario({
    signals,
    linkedAccounts: 1,
    connectNoAccount: false,
    answered,
    confirmed: ledger.confirmed ?? null,
  });
  const currency = (signals.currency || args.currency || plan.currency || 'SAR').toUpperCase();
  const lead = scenarioLead({ scenario, signals, answered, labels: ledger.labels, currency, plan, active: true });
  return { plan: lead.plan ?? stripPlanCategories(plan), lead: lead.decision, firstWhy: lead.firstWhy };
}

/**
 * Loads what the rules need (the newest stored read within 30 days, and the
 * ledger unless the caller already has it) and applies them. Never throws: a
 * failed read is "no read".
 */
export async function adaptiveLockedPlan(args: {
  admin: any | null;
  /** google_ads_accounts.id of the selected account. */
  accountId: string;
  business: (BusinessProfile & { id: string }) | null;
  plan: Plan;
  currency?: string | null;
  /** /home already read the ledger; pass it to skip the second read. */
  ledger?: LedgerEntries;
  now?: Date;
}): Promise<AdaptiveLockedPlan> {
  const { admin, business } = args;
  if (!admin || !business) return { plan: stripPlanCategories(args.plan), lead: null, firstWhy: null };
  const [signals, ledger] = await Promise.all([
    loadLatestSignals(admin, args.accountId, { maxAgeHours: LATEST_SIGNALS_MAX_AGE_HOURS, now: args.now }),
    args.ledger ? Promise.resolve(args.ledger) : readLedgerEntries(admin, business.id),
  ]);
  return applyAdaptiveLock({ plan: args.plan, signals, ledger, business, currency: args.currency });
}
