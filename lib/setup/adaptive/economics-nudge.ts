import type { EconomicsKind } from '../../economics/break-even';
import { missingCoreKeys, missingEconomicsKeys, type SetupKey } from '../questions';
import { readActivityHint } from './activity-hint';
import { adaptivePending } from './bank';
import { classifyScenario } from './scenario';
import { sigValue } from './shared';
import { LATEST_SIGNALS_MAX_AGE_HOURS, isInsideSignalsTtl, loadLatestSignals } from './signals-store';
import type { AccountSignals, ClassifyInput } from './types';

/**
 * The «كمّل تعريف نشاطك» chip on /home counts what is missing; it must never
 * count something the screen it leads to will not ask. The optimizer reads the
 * kind of business from the ledger and the sector (lib/economics/break-even.ts),
 * but the questionnaire asks the margin, the profit per deal and the close rate
 * only for a store, a clinic, a services business or a local shop that the
 * stored read of the account (or the customer's own word) recognised. A new,
 * dormant or no-account customer, or an account the read could not place, is
 * never asked: counting those keys left a chip that could not be cleared.
 *
 * So the economics keys are kept only when `adaptivePending` in edit mode (the
 * mode the chip opens) lists them for the account's real scenario, built from
 * the same inputs the setup screen uses.
 */
export type EconomicsNudgeInput = Pick<ClassifyInput, 'signals' | 'activityHint' | 'confirmed'> & {
  /** The answers on record as the setup screen reads them (choice ids), so the scenario is the one the screen builds. */
  answered: Partial<Record<string, string | null>>;
  /** Linked, non-manager, active accounts. */
  linkedAccounts: number;
};

/** The economics keys still missing that the edit questionnaire would actually ask this account. */
export function askableEconomicsKeys(args: { missing: readonly SetupKey[] } & EconomicsNudgeInput): SetupKey[] {
  if (args.missing.length === 0) return [];
  const scenario = classifyScenario({
    signals: args.signals,
    linkedAccounts: args.linkedAccounts,
    connectNoAccount: false,
    answered: args.answered,
    activityHint: args.activityHint ?? null,
    confirmed: args.confirmed ?? null,
  });
  const asked = new Set(adaptivePending({ scenario, answered: args.answered, consentAnswered: true, edit: true, hasAccount: true }));
  return args.missing.filter((key) => asked.has(key));
}

/**
 * What the home chip counts: the core answers, plus the economics ones the
 * optimizer lacks and the questionnaire can collect. `answeredKeys` is every
 * key on record (the old form's and the ledger's); `kind` is the optimizer's
 * reading of the business.
 */
export function homeMissingKeys(args: { answeredKeys: Iterable<SetupKey>; kind: EconomicsKind | null } & EconomicsNudgeInput): SetupKey[] {
  const answeredKeys = new Set(args.answeredKeys);
  const economics = askableEconomicsKeys({ ...args, missing: missingEconomicsKeys(answeredKeys, args.kind) });
  return [...missingCoreKeys(answeredKeys), ...economics];
}

/**
 * The two reads the scenario stands on, exactly as the setup screen takes them:
 * the stored read of the account only while it is inside the 24-hour onboarding
 * TTL (the edit screen does not read the account again, so an older one asks
 * nothing the chip should promise), and, when that read has no campaigns, what
 * the platform knows about the account's activity. Never throws.
 */
export async function loadEconomicsNudgeInput(args: {
  admin: any;
  supabase: any;
  account: { id: string; last_synced_at?: string | null };
  /** The last seven days' spend already loaded on /home: any spend is enough to say «it spends». */
  weekSpend: number;
  now?: Date;
}): Promise<Pick<EconomicsNudgeInput, 'signals' | 'activityHint'>> {
  let signals: AccountSignals | null = null;
  try {
    const latest = args.admin
      ? await loadLatestSignals(args.admin, args.account.id, { maxAgeHours: LATEST_SIGNALS_MAX_AGE_HOURS, now: args.now })
      : null;
    signals = isInsideSignalsTtl(latest, args.now) ? latest : null;
  } catch {
    signals = null;
  }
  if (sigValue(signals?.campaigns)) return { signals, activityHint: null };
  if (args.weekSpend > 0) return { signals, activityHint: 'spends' };
  try {
    return { signals, activityHint: await readActivityHint(args.supabase, { account: args.account, spend30: null, now: args.now }) };
  } catch {
    return { signals, activityHint: null };
  }
}
