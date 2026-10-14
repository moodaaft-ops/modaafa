import { LINKED_ACCOUNT_SELECT, readAndStoreSignals, type LinkedAccountRow } from './signals-run';
import { canReuseStoredSignals, countOkSignals, loadStoredSignals } from './signals-store';

/**
 * The decisions of POST /api/setup/signals, kept out of the route so they are
 * unit tests with fakes.
 *
 * The account it reads is the one the setup screen reads (`getAccountWorkspace`:
 * the cookie's choice, else the persisted one, else the first). It used to look
 * only at `businesses.selected_google_ads_customer_id`, so a customer who picked
 * an account in the browser had the screen show one account and this route read
 * and store another.
 */
export type SignalsRequestResult = { status: number; body: Record<string, unknown> };

export async function runSignalsRequest(args: {
  /** The caller's own RLS client. */
  supabase: any;
  /** The service client (`job_runs`); null when it could not be created. */
  admin: any | null;
  user: { id: string; email?: string | null };
  /** `getAccountWorkspace(user.id)`. */
  workspace: { business: { id: string } | null; selectedAccount: { id: string } | null };
  now?: Date;
  /** For tests: the read itself. */
  read?: typeof readAndStoreSignals;
}): Promise<SignalsRequestResult> {
  const { workspace, user } = args;
  if (!workspace.business) return { status: 409, body: { error: 'no_business' } };
  if (!workspace.selectedAccount) return { status: 409, body: { error: 'no_account' } };

  // The token column is read through the caller's own client (RLS), scoped to their business.
  let account: LinkedAccountRow | null = null;
  try {
    const { data, error } = await args.supabase
      .from('google_ads_accounts')
      .select(LINKED_ACCOUNT_SELECT)
      .eq('id', workspace.selectedAccount.id)
      .eq('business_id', workspace.business.id)
      .eq('status', 'active')
      .maybeSingle();
    account = error ? null : ((data ?? null) as LinkedAccountRow | null);
  } catch {
    account = null;
  }
  if (!account) return { status: 409, body: { error: 'no_account' } };

  if (!args.admin) return { status: 503, body: { error: 'service_unavailable' } };

  const now = args.now ?? new Date();
  const stored = await loadStoredSignals(args.admin, account.id, now);
  if (canReuseStoredSignals(stored, now)) return { status: 200, body: { ok: true, fresh: false } };

  const run = await (args.read ?? readAndStoreSignals)({ admin: args.admin, account, connectedEmail: user.email ?? null });
  if (!run.ok) return { status: 503, body: { error: run.error } };
  if (!run.saved) return { status: 500, body: { error: 'save_failed' } };
  return { status: 200, body: { ok: true, fresh: true, okSignals: countOkSignals(run.signals) } };
}
