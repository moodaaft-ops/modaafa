import { decrypt } from '@/lib/crypto';
import { getConfiguredGoogleAdsManagerIds, getCustomer } from '@/lib/google-ads/client';
import type { GaqlCustomer } from '@/lib/jarvis/tools/types';
import { ownManagerIdsFrom, readAccountSignals } from './signals';
import { saveSignals } from './signals-store';
import type { AccountSignals } from './types';

/** The columns both routes select for a linked account. */
export const LINKED_ACCOUNT_SELECT = 'id, customer_id, manager_id, currency_code, refresh_token_encrypted';

export type LinkedAccountRow = {
  id: string;
  customer_id: string;
  manager_id: string | null;
  currency_code: string | null;
  refresh_token_encrypted: string | null;
};

type Deps = {
  decrypt: (payload: string) => string;
  getCustomer: (customerId: string, refreshToken: string, loginCustomerId?: string) => GaqlCustomer;
  managerIds: () => string[];
};

const defaultDeps: Deps = {
  decrypt,
  getCustomer: (customerId, refreshToken, loginCustomerId) => getCustomer(customerId, refreshToken, loginCustomerId) as unknown as GaqlCustomer,
  managerIds: () => getConfiguredGoogleAdsManagerIds(),
};

export type RunSignalsResult =
  | { ok: true; signals: AccountSignals; saved: boolean }
  | { ok: false; error: 'client_unavailable' };

/**
 * One fresh read of a linked account, stored in `job_runs`. Shared by the
 * onboarding route and the operator page so both read the account the same
 * way. The Google client is built exactly as lib/jarvis/turn.ts builds it.
 */
export async function readAndStoreSignals(
  args: { admin: any; account: LinkedAccountRow; connectedEmail: string | null; timeoutMs?: number; now?: Date },
  deps: Deps = defaultDeps
): Promise<RunSignalsResult> {
  const { admin, account, connectedEmail } = args;
  let customer: GaqlCustomer;
  try {
    if (!account.refresh_token_encrypted) return { ok: false, error: 'client_unavailable' };
    const refreshToken = deps.decrypt(account.refresh_token_encrypted);
    customer = deps.getCustomer(account.customer_id, refreshToken, account.manager_id ?? undefined);
  } catch {
    console.warn('[onboarding-signals] google ads client unavailable for this account');
    return { ok: false, error: 'client_unavailable' };
  }

  const signals = await readAccountSignals(customer, {
    customerId: String(account.customer_id).replace(/\D/g, ''),
    currency: account.currency_code || 'SAR',
    connectedEmail,
    // The manager the account was connected through is the connecting person's own (they reached the
    // account with it), so a link to it is not an outside agency.
    ownManagerIds: ownManagerIdsFrom([...safeManagerIds(deps), account.manager_id]),
    timeoutMs: args.timeoutMs,
    now: args.now,
  });
  const saved = await saveSignals(admin, account.id, signals);
  return { ok: true, signals, saved };
}

function safeManagerIds(deps: Deps) {
  try {
    return deps.managerIds();
  } catch {
    return [];
  }
}
