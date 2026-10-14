import {
  breakEvenForCurrency,
  computeBreakEven,
  type BreakEven,
  type EconomicsFactData,
  type EconomicsFacts,
} from './break-even';

/**
 * Reads the onboarding answers the break-even needs and turns them into a
 * BreakEven. Read-only: one select on business_memory, no writes, and it never
 * throws. The same pattern as lib/setup/ledger.ts (source onboarding, status
 * active, newest fact per `data.setup_key`), so a re-answered question
 * replaces the old answer and nothing new is stored anywhere.
 *
 * Callers pass a service-role client (the optimizer cron has one); a client
 * with row-level security would simply see no rows and report everything
 * missing.
 */

const ECONOMICS_KEYS = ['confirm', 'type', 'margin', 'deal_value', 'close_rate', 'aov_check'] as const;
type EconomicsKey = (typeof ECONOMICS_KEYS)[number];

/** Same ceiling lib/setup/ledger.ts reads: the answers of one business are far fewer than this. */
const FACT_ROW_LIMIT = 60;

export async function loadEconomicsFacts(admin: any, businessId: string): Promise<EconomicsFacts | null> {
  if (!admin || !businessId) return null;
  try {
    const { data, error } = await admin
      .from('business_memory')
      .select('data, created_at')
      .eq('business_id', businessId)
      .eq('source', 'onboarding')
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(FACT_ROW_LIMIT);
    if (error || !Array.isArray(data)) return null;

    const facts: EconomicsFacts = {};
    for (const row of data) {
      const payload = row?.data;
      if (!payload || typeof payload !== 'object') continue;
      const key = (payload as EconomicsFactData).setup_key;
      if (typeof key !== 'string' || !(ECONOMICS_KEYS as readonly string[]).includes(key)) continue;
      // Rows arrive newest first: the first one seen per key is the current answer.
      if (facts[key as EconomicsKey]) continue;
      facts[key as EconomicsKey] = payload as EconomicsFactData;
    }
    return facts;
  } catch {
    return null;
  }
}

/**
 * Break-even for one business. A read that failed is reported as "nothing on
 * record" (every input missing), which only ever withholds budget and bid
 * changes; it never invents a number.
 */
export async function loadEconomics(
  admin: any,
  input: {
    businessId: string | null | undefined;
    sector?: string | null;
    primaryGoal?: string | null;
    accountCurrency?: string | null;
  }
): Promise<BreakEven> {
  const facts = input.businessId ? await loadEconomicsFacts(admin, input.businessId) : null;
  const economics = computeBreakEven({
    facts: facts ?? {},
    sector: input.sector ?? null,
    primaryGoal: input.primaryGoal ?? null,
  });
  return breakEvenForCurrency(economics, input.accountCurrency);
}
