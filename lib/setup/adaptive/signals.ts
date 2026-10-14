import type { GaqlCustomer } from '@/lib/jarvis/tools/types';
import type { AccountSignals } from './types';

/** Overall budget for one read; a query still running at the deadline counts as failed. */
export const SIGNALS_TIMEOUT_MS = 6000;

export type ReadSignalsContext = {
  /** 10 digits, no dashes. */
  customerId: string;
  currency: string;
  /** The email the account was connected with; edits by it are not «someone else». */
  connectedEmail: string | null;
  /** Manager ids that are ours (Modaafa's MCC, GOOGLE_ADS_MANAGER_IDS): a link to them is not an outside agency. */
  ownManagerIds: string[];
  timeoutMs?: number;
  now?: Date;
};

/**
 * CONTRACT (part A): reads every signal in parallel, each query on its own
 * with its own catch, inside one overall deadline. Never throws.
 */
export async function readAccountSignals(customer: GaqlCustomer, ctx: ReadSignalsContext): Promise<AccountSignals> {
  void customer;
  const fail = { ok: false as const, error: 'not_implemented' };
  return {
    version: 1,
    readAt: (ctx.now ?? new Date()).toISOString(),
    customerId: ctx.customerId,
    currency: ctx.currency,
    campaigns: fail,
    enabledConversionActions: fail,
    conversionsByGroup: fail,
    autoTagging: fail,
    landingHosts: fail,
    merchantCenterLinked: fail,
    assets: fail,
    targetedPlaces: fail,
    externalManager: fail,
    otherEditors14d: fail,
    hours: fail,
    products: fail,
  };
}
