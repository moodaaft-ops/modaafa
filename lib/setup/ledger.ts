import { BUSINESS_KINDS, DOMINANT_OUTCOMES, type BusinessKind, type DominantOutcome } from './adaptive/types';
import { deriveEconomicsKind, type EconomicsFacts, type EconomicsKind } from '../economics/break-even';
import { cleanUserText, isSetupKey, type SetupKey } from './questions';

/**
 * The onboarding answers on record (`business_memory`, source onboarding).
 * Lives apart from lib/setup/load.ts so a screen that only needs the ledger
 * (the plan lock, the answer route) does not pull the whole setup loader, and
 * lib/plan/load.ts can use it without a circular import. load.ts re-exports
 * everything here, so existing imports keep working.
 */

export type LedgerEntries = {
  /** The newest active choice id per setup key (null when the answer has none, like a budget). */
  choices: Map<SetupKey, string | null>;
  /** The words the customer saw when they answered (`data.label`, at most 120 characters), where the fact kept them. */
  labels: Partial<Record<SetupKey, string>>;
  /**
   * The kind and outcome the customer agreed with on the opener («إي صح»), from
   * the newest `confirm` fact. Only when that newest fact is a «yes» that kept
   * a kind. Adaptive onboarding only; absent for everyone else.
   */
  confirmed?: { kind: BusinessKind; outcome: DominantOutcome | null } | null;
};

export const LEDGER_LABEL_MAX = 120;

export function emptyLedger(): LedgerEntries {
  return { choices: new Map<SetupKey, string | null>(), labels: {} };
}

function confirmedFrom(data: Record<string, unknown>): LedgerEntries['confirmed'] {
  if (data.choice !== 'yes') return null;
  const kind = data.kind;
  if (typeof kind !== 'string' || !(BUSINESS_KINDS as readonly string[]).includes(kind)) return null;
  const outcome = data.outcome;
  const known = typeof outcome === 'string' && (DOMINANT_OUTCOMES as readonly string[]).includes(outcome);
  return { kind: kind as BusinessKind, outcome: known ? (outcome as DominantOutcome) : null };
}

/**
 * Onboarding answers on record: the newest active fact per setup key, with the
 * label it was shown under. Any failure (table not migrated, service key
 * missing) reads as "nothing on record", which only means a question may be
 * asked again.
 */
export async function readLedgerEntries(admin: any, businessId: string): Promise<LedgerEntries> {
  const out = emptyLedger();
  if (!admin) return out;
  try {
    const { data, error } = await admin
      .from('business_memory')
      .select('data, created_at')
      .eq('business_id', businessId)
      .eq('source', 'onboarding')
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(60);
    if (error || !Array.isArray(data)) return out;
    for (const row of data) {
      const key = row?.data?.setup_key;
      if (!isSetupKey(key) || out.choices.has(key)) continue;
      const choice = typeof row.data.choice === 'string' ? row.data.choice : null;
      out.choices.set(key, choice);
      const label = typeof row.data.label === 'string' ? cleanUserText(row.data.label, LEDGER_LABEL_MAX) : '';
      if (label) out.labels[key] = label;
      if (key === 'confirm') out.confirmed = confirmedFrom(row.data);
    }
    return out;
  } catch {
    return out;
  }
}

/** Same read as `readLedgerEntries`, choices only: what /home uses. */
export async function readLedger(admin: any, businessId: string): Promise<Map<SetupKey, string | null>> {
  return (await readLedgerEntries(admin, businessId)).choices;
}

/**
 * The kind of business the optimizer will take this one for, from the answers
 * on record: the same derivation lib/economics/break-even.ts runs over the
 * stored facts, fed from the ledger's choices. It decides which economics
 * answers (lib/setup/questions.ts missingEconomicsKeys) the home screen asks for.
 */
export function economicsKindFromLedger(
  entries: LedgerEntries,
  business: { sector?: string | null; primary_goal?: string | null } | null | undefined
): EconomicsKind {
  const facts: EconomicsFacts = {};
  const type = entries.choices.get('type');
  if (type) facts.type = { choice: type };
  if (entries.confirmed) facts.confirm = { choice: 'yes', kind: entries.confirmed.kind };
  // The question that was asked says what the tree thought the business was; only its presence matters.
  for (const key of ['margin', 'deal_value', 'profit_per_deal', 'close_rate'] as const) {
    if (entries.choices.has(key)) facts[key] = {};
  }
  return deriveEconomicsKind({ facts, sector: business?.sector ?? null, primaryGoal: business?.primary_goal ?? null });
}
