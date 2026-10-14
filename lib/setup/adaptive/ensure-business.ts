import { createAdminClient } from '@/lib/supabase/server';

type SetupUser = { id: string; email?: string | null; user_metadata?: Record<string, any> | null };

export type SetupBusiness = { id: string; selected_google_ads_customer_id: string | null };

/**
 * The workspace row a customer needs before they can answer «ما عندي حساب
 * إعلانات». Until now only the Google Ads callback created it, so someone who
 * never connected had no `businesses` row and nowhere to write answers.
 *
 * Mirrors `getOrCreateUserBusiness` and `ensureUserProfile` in
 * app/api/auth/google-ads/callback/route.ts, which stays untouched:
 * - `businesses.user_id` is UNIQUE and references `users(id)`, so the profile
 *   row has to exist first. The auth trigger normally made it already; it is
 *   inserted here only when missing (ignoreDuplicates, so a signed-in customer's
 *   name and last login are never overwritten).
 * - The business goes in through the caller's own RLS client with an upsert on
 *   the unique `user_id`, so a double tap cannot create a second workspace;
 *   `ignoreDuplicates` returns no row when one already exists, which is read
 *   again.
 *
 * Returns null when no business could be made or found. Never throws.
 */
export async function ensureSetupBusiness(
  supabase: any,
  user: SetupUser,
  opts: { admin?: any | null } = {}
): Promise<SetupBusiness | null> {
  try {
    const existing = await readBusiness(supabase, user.id);
    if (existing) return existing;

    await ensureUserProfile(user, opts.admin);

    const fallbackName =
      user.user_metadata?.business_name ??
      user.user_metadata?.full_name ??
      user.user_metadata?.name ??
      user.email?.split('@')[0] ??
      'نشاطي';

    const { data: created, error } = await supabase
      .from('businesses')
      .upsert(
        {
          user_id: user.id,
          name: String(fallbackName).slice(0, 120),
          primary_goal: 'leads',
          target_regions: [],
        },
        { onConflict: 'user_id', ignoreDuplicates: true }
      )
      .select('id, selected_google_ads_customer_id')
      .maybeSingle();

    if (error) {
      console.warn('[setup] could not create the workspace for a customer without an ads account');
      return null;
    }
    if (created) return created as SetupBusiness;

    // ignoreDuplicates returns no row when the business already existed.
    return await readBusiness(supabase, user.id);
  } catch {
    console.warn('[setup] could not create the workspace for a customer without an ads account');
    return null;
  }
}

async function readBusiness(supabase: any, userId: string): Promise<SetupBusiness | null> {
  const { data, error } = await supabase
    .from('businesses')
    .select('id, selected_google_ads_customer_id')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as SetupBusiness | null) ?? null;
}

async function ensureUserProfile(user: SetupUser, adminOverride?: any | null) {
  try {
    const admin = adminOverride === undefined ? createAdminClient() : adminOverride;
    if (!admin) return;
    await admin.from('users').upsert(
      {
        id: user.id,
        email: user.email,
        name: user.user_metadata?.full_name ?? user.user_metadata?.name ?? null,
        avatar_url: user.user_metadata?.avatar_url ?? user.user_metadata?.picture ?? null,
        last_login_at: new Date().toISOString(),
      },
      { onConflict: 'id', ignoreDuplicates: true }
    );
  } catch {
    console.warn('[setup] could not ensure the profile row before creating the workspace');
  }
}
