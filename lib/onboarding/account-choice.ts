/**
 * Ordering and status labels for the onboarding account chooser.
 *
 * The callback used to pick an account by NAME quality, so an owner with 39
 * accounts landed on an empty one. The chooser orders by what the account
 * actually spent in the last 30 days and leaves the decision to the user.
 */

export type ChoosableAccount = {
  customer_id: string;
  customer_name: string | null;
  google_status?: string | null;
  currency_code?: string | null;
};

export type AccountStatusTone = 'active' | 'attention' | 'stopped';

export function accountStatusView(googleStatus?: string | null): { tone: AccountStatusTone; label: string } {
  switch ((googleStatus ?? '').toUpperCase()) {
    case 'ENABLED':
      return { tone: 'active', label: 'شغّال' };
    case 'SUSPENDED':
      return { tone: 'attention', label: 'موقوف من Google' };
    case 'CANCELED':
    case 'CANCELLED':
    case 'CLOSED':
      return { tone: 'stopped', label: 'مغلق' };
    default:
      return { tone: 'stopped', label: 'الحالة غير معروفة' };
  }
}

export type RankedAccount<T extends ChoosableAccount> = T & { spend: number | null };

export function sortAccountsBySpend<T extends ChoosableAccount>(
  accounts: T[],
  spendByCustomerId: Record<string, number | null | undefined> = {}
): Array<RankedAccount<T>> {
  const statusRank: Record<AccountStatusTone, number> = { active: 0, attention: 1, stopped: 2 };
  return accounts
    .map((account) => {
      const raw = spendByCustomerId[account.customer_id.replace(/\D/g, '')];
      const spend = typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
      return { ...account, spend };
    })
    .sort((a, b) => {
      // Known spend first, biggest first. Unknown spend is not "zero".
      if (a.spend !== null && b.spend !== null && a.spend !== b.spend) return b.spend - a.spend;
      if (a.spend === null && b.spend !== null) return 1;
      if (a.spend !== null && b.spend === null) return -1;
      const statusDiff =
        statusRank[accountStatusView(a.google_status).tone] - statusRank[accountStatusView(b.google_status).tone];
      if (statusDiff !== 0) return statusDiff;
      return a.customer_id.localeCompare(b.customer_id);
    });
}

/** Arabic count of accounts with the right plural form. */
export function accountsCountLabel(count: number) {
  if (count <= 0) return 'لا يوجد حساب';
  if (count === 1) return 'حساب واحد';
  if (count === 2) return 'حسابان';
  const lastTwo = count % 100;
  if (lastTwo >= 3 && lastTwo <= 10) return `${count} حسابات`;
  if (lastTwo === 0 || lastTwo === 1 || lastTwo === 2) return `${count} حساب`;
  return `${count} حساباً`;
}
