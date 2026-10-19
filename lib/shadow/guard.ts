import { shadowModeEnabled } from './flag';

function isMissingTable(error: unknown) {
  const code = error && typeof error === 'object' ? (error as { code?: string }).code : undefined;
  return code === '42P01' || code === 'PGRST205';
}

/**
 * True when the account is an agency shadow account: the optimizer reads it, an
 * operator reviews its cards, and nothing ever executes on it.
 *
 * Flag off: false without touching the database, so behaviour is unchanged.
 * Flag on: a read that fails for any reason other than "table not there yet"
 * counts as shadow, because refusing a real execution once is better than
 * running one on an agency account.
 *
 * `admin` must be the service-role client. The table has no owner policy, so a
 * user-session client would see nothing and answer false.
 */
export async function isShadowAccount(
  accountId: string,
  deps: { admin: () => any; enabled?: boolean } = { admin: () => null }
): Promise<boolean> {
  if (!(deps.enabled ?? shadowModeEnabled())) return false;
  try {
    const admin = deps.admin();
    if (!admin) return true;
    const { data, error } = await admin
      .from('shadow_accounts')
      .select('account_id')
      .eq('account_id', accountId)
      .maybeSingle();
    if (error) return !isMissingTable(error);
    return Boolean(data);
  } catch {
    return true;
  }
}

export async function loadShadowAccountIds(admin: any, accountIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (accountIds.length === 0) return out;
  const { data, error } = await admin.from('shadow_accounts').select('account_id').in('account_id', accountIds);
  if (error) {
    if (isMissingTable(error)) return out;
    // Unreadable (not missing): hold every account back this run, the same
    // fail-closed rule as excludeShadowAccounts. The optimizer then records
    // shadow decisions only: no card is queued and nothing executes.
    console.error('Shadow accounts unreadable; every account is held back this run', error.message);
    return new Set(accountIds);
  }
  for (const row of data ?? []) out.add(row.account_id);
  return out;
}

/**
 * Drops agency shadow accounts from a list of rows with an `id` (the guard run,
 * the measurement scan). Flag off: the same array, no database read. Flag on and
 * the state unreadable (not just a missing table): nothing is returned, because
 * mailing or proposing for an agency account by mistake is the worse failure.
 */
export async function excludeShadowAccounts<T extends { id: string }>(
  admin: any,
  rows: T[],
  enabled: boolean = shadowModeEnabled()
): Promise<T[]> {
  if (!enabled || rows.length === 0) return rows;
  try {
    const { data, error } = await admin.from('shadow_accounts').select('account_id').in('account_id', rows.map((r) => r.id));
    if (error) return isMissingTable(error) ? rows : [];
    const shadow = new Set((data ?? []).map((r: any) => String(r.account_id)));
    return rows.filter((r) => !shadow.has(r.id));
  } catch {
    return [];
  }
}
