import { cookies } from 'next/headers';
import { isGeneratedFallbackName } from './display';
import { requestCache } from '@/lib/platform/request-cache';
import { getRequestServerClient } from '@/lib/supabase/server';

export const SELECTED_ADS_ACCOUNT_COOKIE = 'modaafa_selected_customer_id';

/**
 * Upper bound on accounts loaded into a dashboard render. PostgREST otherwise
 * truncates at its default of 1000 with no signal at all; this at least makes
 * the ceiling explicit and keeps the RSC payload bounded.
 */
export const ACCOUNT_LIST_LIMIT = 500;

export type AdsAccountSummary = {
  id: string;
  customer_id: string;
  customer_name: string | null;
  manager_id?: string | null;
  status?: string | null;
  is_manager?: boolean | null;
  google_status?: string | null;
  currency_code?: string | null;
  time_zone?: string | null;
  last_synced_at?: string | null;
};

export type BusinessSummary = {
  id: string;
  name?: string | null;
  sector?: string | null;
  website?: string | null;
  monthly_budget?: number | null;
  primary_goal?: string | null;
  target_regions?: string[] | null;
  selected_google_ads_customer_id?: string | null;
};

export type GoogleAdsSelectableAccount = {
  customer_id?: string | null;
  customer_name?: string | null;
  manager_id?: string | null;
  status?: string | null;
  currency_code?: string | null;
  time_zone?: string | null;
};

async function loadUserBusiness(
  supabase: any,
  userId?: string | null
): Promise<BusinessSummary | null> {
  const resolvedUserId =
    userId ??
    (await supabase.auth.getUser().catch(() => ({ data: { user: null } })))?.data?.user?.id ??
    null;

  if (!resolvedUserId) return null;

  const { data, error } = await supabase
    .from('businesses')
    .select(
      'id, name, sector, website, monthly_budget, primary_goal, target_regions, selected_google_ads_customer_id'
    )
    .eq('user_id', resolvedUserId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error('Failed to load user business', error);
    return null;
  }

  return data ?? null;
}

export const getUserBusiness = requestCache(async (userId: string): Promise<BusinessSummary | null> => {
  const supabase = await getRequestServerClient();
  return loadUserBusiness(supabase, userId);
});

/** Route Handlers already own a request-bound client, so they use this form. */
export function getUserBusinessWithClient(supabase: any, userId?: string | null) {
  return loadUserBusiness(supabase, userId);
}

export const getAccountWorkspace = requestCache(async (userId: string) => {
  const supabase = await getRequestServerClient();
  const cookieStore = await cookies();
  const selectedFromCookie = normalizeCustomerId(
    cookieStore.get(SELECTED_ADS_ACCOUNT_COOKIE)?.value ?? ''
  );
  const business = await getUserBusiness(userId);

  if (!business) {
    return {
      business: null,
      accounts: [] as AdsAccountSummary[],
      revokedAccounts: [] as AdsAccountSummary[],
      selectedAccount: null,
      selectedCustomerId: null,
    };
  }

  const { data, error } = await supabase
    .from('google_ads_accounts')
    .select(
      'id, customer_id, customer_name, manager_id, status, is_manager, google_status, currency_code, time_zone, last_synced_at'
    )
    .eq('business_id', business.id)
    .in('status', ['active', 'revoked'])
    // Manager accounts can never answer a metrics query, so they must not be
    // selectable. The env-based MCC list below only ever knew about Modaafa's
    // own manager — a customer who connected their own agency MCC got no
    // filtering at all until `is_manager` was persisted.
    .not('is_manager', 'is', true)
    .order('linked_at', { ascending: false })
    .limit(ACCOUNT_LIST_LIMIT);

  if (error) {
    console.error('Failed to load Google Ads accounts', error);
  }

  const { accounts, revokedAccounts } = partitionGoogleAdsAccounts(
    (data ?? []) as AdsAccountSummary[]
  );

  const selectedAccount = pickSelectedAdsAccount(
    accounts,
    selectedFromCookie,
    business.selected_google_ads_customer_id
  );

  return {
    business,
    accounts,
    revokedAccounts,
    selectedAccount,
    selectedCustomerId: selectedAccount?.customer_id ?? null,
  };
});

export function partitionGoogleAdsAccounts(
  rows: AdsAccountSummary[],
  managerIds = configuredManagerCustomerIdSet()
) {
  const clientAccounts = rows
    .map((account) => ({
      ...account,
      customer_id: normalizeCustomerId(account.customer_id),
    }))
    .filter((account) => !managerIds.has(account.customer_id) && account.is_manager !== true);

  return {
    accounts: clientAccounts.filter((account) => account.status === 'active'),
    revokedAccounts: clientAccounts.filter((account) => account.status === 'revoked'),
  };
}

export function pickSelectedAdsAccount<T extends { customer_id?: string | null }>(
  accounts: T[],
  cookieCustomerId?: string | null,
  persistedCustomerId?: string | null
): T | null {
  const normalizedCookieId = normalizeCustomerId(cookieCustomerId ?? '');
  const normalizedPersistedId = normalizeCustomerId(persistedCustomerId ?? '');

  return (
    accounts.find((account) => normalizeCustomerId(account.customer_id ?? '') === normalizedCookieId) ??
    accounts.find(
      (account) => normalizeCustomerId(account.customer_id ?? '') === normalizedPersistedId
    ) ??
    accounts[0] ??
    null
  );
}

export async function getLinkedGoogleAdsAccount({
  supabase,
  userId,
  customerId,
  select = 'id, customer_id, customer_name, manager_id, refresh_token_encrypted',
}: {
  supabase: any;
  userId?: string | null;
  customerId?: string | null;
  select?: string;
}) {
  const business = await loadUserBusiness(supabase, userId);
  if (!business) return { business: null, account: null, error: 'business_not_found' as const };

  const managerIds = configuredManagerCustomerIdSet();
  const normalizedCustomerId = normalizeCustomerId(customerId ?? '');

  if (normalizedCustomerId && managerIds.has(normalizedCustomerId)) {
    return { business, account: null, error: 'account_not_found' as const };
  }

  let query = supabase
    .from('google_ads_accounts')
    .select(select)
    .eq('business_id', business.id)
    .eq('status', 'active')
    .not('is_manager', 'is', true)
    .order('linked_at', { ascending: false });

  if (normalizedCustomerId) {
    query = query.eq('customer_id', normalizedCustomerId);
  } else {
    query = query.limit(50);
  }

  const { data, error } = normalizedCustomerId ? await query.maybeSingle() : await query;
  if (error) {
    console.error('Failed to load linked Google Ads account', error);
    return { business, account: null, error: 'account_lookup_failed' as const };
  }

  const account = normalizedCustomerId
    ? data ?? null
    : ((data ?? []) as any[]).find((row) => !managerIds.has(normalizeCustomerId(row.customer_id))) ?? null;

  return { business, account, error: account ? null : ('account_not_found' as const) };
}

export function normalizeCustomerId(value: string) {
  return value.replace(/\D/g, '');
}

export function pickPreferredGoogleAdsAccount<T extends { customer_id?: string | null }>(
  savedAccounts: T[] | null | undefined,
  sourceAccounts: GoogleAdsSelectableAccount[] = []
): T | null {
  const accounts = savedAccounts ?? [];
  if (accounts.length === 0) return null;

  const sourceById = new Map(
    sourceAccounts.map((account) => [normalizeCustomerId(account.customer_id ?? ''), account])
  );

  return [...accounts].sort((a, b) => {
    const aSource = sourceById.get(normalizeCustomerId(a.customer_id ?? '')) ?? {};
    const bSource = sourceById.get(normalizeCustomerId(b.customer_id ?? '')) ?? {};
    const scoreDiff = accountSelectionScore(bSource) - accountSelectionScore(aSource);
    if (scoreDiff !== 0) return scoreDiff;
    return normalizeCustomerId(a.customer_id ?? '').localeCompare(normalizeCustomerId(b.customer_id ?? ''));
  })[0] ?? null;
}

export function pickPersistedOrPreferredGoogleAdsAccount<
  T extends { customer_id?: string | null },
>(
  savedAccounts: T[] | null | undefined,
  persistedCustomerId?: string | null,
  sourceAccounts: GoogleAdsSelectableAccount[] = []
): T | null {
  const accounts = savedAccounts ?? [];
  const normalizedPersistedId = normalizeCustomerId(persistedCustomerId ?? '');
  const persistedAccount = normalizedPersistedId
    ? accounts.find(
        (account) =>
          normalizeCustomerId(account.customer_id ?? '') === normalizedPersistedId
      )
    : null;

  return persistedAccount ?? pickPreferredGoogleAdsAccount(accounts, sourceAccounts);
}

function accountSelectionScore(account: GoogleAdsSelectableAccount) {
  if (configuredManagerCustomerIdSet().has(normalizeCustomerId(account.customer_id ?? ''))) return -1;

  const hasRealName = Boolean(account.customer_name?.trim()) && !isGeneratedFallbackName(account.customer_name);
  let score = hasRealName ? 100 : 0;
  if (account.status === 'ENABLED' || !account.status) score += 20;
  if (account.manager_id) score += 8;
  if (account.currency_code) score += 4;
  if (account.time_zone) score += 4;
  return score;
}

function configuredManagerCustomerIdSet() {
  return new Set(
    [
      process.env.GOOGLE_ADS_MANAGER_CUSTOMER_ID,
      process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID,
      process.env.GOOGLE_ADS_MCC_CUSTOMER_ID,
      process.env.MOODAAFT_MANAGER_CUSTOMER_ID,
    ]
      .flatMap((value) => (value ?? '').split(','))
      .map(normalizeCustomerId)
      .filter(Boolean)
  );
}
