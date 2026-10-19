/**
 * Which accounts the monthly review looks at: accounts of subscribed owners
 * (the same set the hourly optimizer is allowed to work on, so the plan cap
 * and the trial rules are the same), that have no monthly report for the
 * reviewed month yet. Read only.
 */

import { decrypt } from '../crypto';
import { getCustomer } from '../google-ads/client';
import { chunkIds, getOptimizerAllowedAccountIds } from '../platform/jobs';
import type { ListAccounts, MonthlyAccount } from './monthly-run';

export function listMonthlyAccounts(supabase: any): ListAccounts {
  return async (limit, window) => {
    const { allowedAccounts } = await getOptimizerAllowedAccountIds(supabase);
    const ids = allowedAccounts.map((account) => account.id);
    if (ids.length === 0) return [];

    const reported = new Set<string>();
    for (const part of chunkIds(ids, 100)) {
      const { data } = await supabase
        .from('reports')
        .select('account_id')
        .eq('period_type', 'monthly')
        .eq('period_start', window.from)
        .in('account_id', part);
      for (const row of data ?? []) reported.add(row.account_id);
    }
    const pending = ids.filter((id) => !reported.has(id)).slice(0, limit);
    if (pending.length === 0) return [];

    const { data: rows } = await supabase
      .from('google_ads_accounts')
      .select('id, customer_id, customer_name, manager_id, currency_code, refresh_token_encrypted, business_id')
      .eq('status', 'active')
      .not('is_manager', 'is', true)
      .in('id', pending);

    const businessIds = [...new Set((rows ?? []).map((row: any) => row.business_id).filter(Boolean))] as string[];
    const businesses = new Map<string, { user_id: string; sector: string | null; primary_goal: string | null; monthly_budget: number | null }>();
    if (businessIds.length > 0) {
      const { data } = await supabase
        .from('businesses')
        .select('id, user_id, sector, primary_goal, monthly_budget')
        .in('id', businessIds);
      for (const row of data ?? []) businesses.set(row.id, row);
    }
    const ownerIds = [...new Set([...businesses.values()].map((b) => b.user_id))];
    const owners = new Map<string, { id: string; email: string; name: string | null; messages_opt_out: boolean | null }>();
    if (ownerIds.length > 0) {
      const { data } = await supabase.from('users').select('id, email, name, messages_opt_out').in('id', ownerIds);
      for (const row of data ?? []) owners.set(row.id, row);
    }

    const out: MonthlyAccount[] = [];
    for (const row of rows ?? []) {
      let customer;
      try {
        customer = getCustomer(row.customer_id, decrypt(row.refresh_token_encrypted), row.manager_id ?? undefined);
      } catch {
        continue; // a token that cannot be read is the sync cron's problem, not this one's
      }
      const business = row.business_id ? businesses.get(row.business_id) : undefined;
      out.push({
        id: row.id,
        customer_id: row.customer_id,
        customer_name: row.customer_name ?? null,
        currency_code: row.currency_code ?? null,
        business_id: row.business_id ?? null,
        sector: business?.sector ?? null,
        primary_goal: business?.primary_goal ?? null,
        monthly_budget: business?.monthly_budget ?? null,
        owner: business ? owners.get(business.user_id) ?? null : null,
        customer,
      });
    }
    // Keep the order of the allowed list.
    const position = new Map(pending.map((id, index) => [id, index]));
    return out.sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0));
  };
}
