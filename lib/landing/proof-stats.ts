import { unstable_cache } from 'next/cache';
import { createAdminClient } from '@/lib/supabase/server';

/**
 * Live proof for the landing hero: how many distinct Google Ads accounts have
 * been audited. Read from the audits table, never typed by hand.
 *
 * Spend analysed is deliberately not here: audits do not store the account's
 * spend, and campaigns_cache is a latest-state mirror that drops with the
 * account, so a sum from it would not be "what we analysed". Adding it needs a
 * stored column at audit time (a separate change).
 *
 * Any failure returns null and the line stays hidden.
 */
const ROW_CAP = 20000;

async function readAuditedAccounts(): Promise<number | null> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.from('audits').select('account_id').limit(ROW_CAP);
    if (error || !Array.isArray(data)) return null;
    // A truncated read would understate, so treat hitting the cap as unknown.
    if (data.length >= ROW_CAP) return null;
    return new Set(data.map((row: { account_id: string }) => row.account_id)).size;
  } catch {
    return null;
  }
}

const cachedAuditedAccounts = unstable_cache(readAuditedAccounts, ['landing-proof-audited-accounts'], {
  revalidate: 3600,
});

/** Returns the count only when it reaches the owner's minimum, otherwise null. */
export async function getAuditedAccountsForProof(minimum: number | null): Promise<number | null> {
  if (minimum === null) return null;
  const count = await cachedAuditedAccounts().catch(() => null);
  if (count === null || count < minimum) return null;
  return count;
}
