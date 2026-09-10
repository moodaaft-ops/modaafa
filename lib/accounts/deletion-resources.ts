const PAGE_SIZE = 500;

/** Read the complete revocation inventory before any irreversible cleanup. */
export async function loadAccountDeletionResources(supabase: any, userId: string) {
  if (!userId) throw new Error('Deletion requires a user id');
  const subscriptions = await readPages<{ id: string; stripe_subscription_id: string | null }>(() =>
    supabase.from('subscriptions').select('id, stripe_subscription_id')
      .eq('user_id', userId).in('status', ['trialing', 'active', 'past_due', 'paused'])
  );
  const businesses = await readPages<{ id: string }>(() =>
    supabase.from('businesses').select('id').eq('user_id', userId)
  );
  const adAccounts: Array<{ id: string; refresh_token_encrypted: string | null }> = [];
  for (const business of businesses) {
    adAccounts.push(...await readPages<{ id: string; refresh_token_encrypted: string | null }>(() =>
      supabase.from('google_ads_accounts').select('id, refresh_token_encrypted')
        .eq('business_id', business.id)
    ));
  }
  return { subscriptions, adAccounts };
}

async function readPages<T>(query: () => any): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await query().order('id', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error || !Array.isArray(data)) {
      throw new Error('Cannot verify the complete account deletion inventory', { cause: error });
    }
    rows.push(...data);
    if (data.length < PAGE_SIZE) return rows;
  }
}
