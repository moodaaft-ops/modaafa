import { redirect } from 'next/navigation';
import { createServerClient } from '@/lib/supabase/server';
import { listAccessibleCustomers } from '@/lib/google-ads/client';
import { decrypt } from '@/lib/crypto';
import SelectAccountForm from './select-form';

/**
 * Account selection page.
 *
 * Reads the user's linked google_ads_accounts row, decrypts the refresh
 * token, re-lists accessible customers, and lets the user pick which one
 * should be the active linked account. Reachable from:
 *   - OAuth callback (when the email has multiple accessible accounts)
 *   - /settings (manual switch)
 */
export default async function SelectAccountPage() {
  const supabase = createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // Get the user's currently linked account (RLS scopes to user)
  const { data: account } = await supabase
    .from('google_ads_accounts')
    .select('id, customer_id, refresh_token_encrypted')
    .eq('status', 'active')
    .limit(1)
    .maybeSingle();

  if (!account) {
    // No account linked yet — send user to connect first
    redirect('/onboarding/connect');
  }

  let customerIds: string[] = [];
  let listError: string | null = null;

  try {
    const refreshToken = decrypt(account.refresh_token_encrypted);
    customerIds = await listAccessibleCustomers(refreshToken);
  } catch (err: any) {
    console.error('[select-account] failed to list customers:', err?.message);
    listError = err?.message ?? 'فشل في جلب قائمة الحسابات';
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-ink-50 to-brand-50 p-4">
      <div className="w-full max-w-xl bg-white rounded-3xl shadow-xl p-8 md:p-10">
        <div className="text-center mb-8">
          <div className="inline-flex w-16 h-16 rounded-2xl bg-gradient-to-br from-brand-500 to-cyan-500 items-center justify-center text-white text-3xl font-bold mb-4">
            ×
          </div>
          <h1 className="text-2xl font-bold mb-1">اختر حساب Google Ads</h1>
          <p className="text-ink-500 text-sm">
            {customerIds.length > 0
              ? `وجدنا ${customerIds.length} حساب مرتبط — اختر اللي تبي تربطه بـ مُضاعِف`
              : 'اختر الحساب الإعلاني'}
          </p>
        </div>

        {listError ? (
          <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-red-700 text-sm text-center">
            تعذّر جلب الحسابات: {listError}
            <div className="mt-2">
              <a
                href="/api/auth/google-ads/connect"
                className="text-brand-600 underline"
              >
                إعادة الربط
              </a>
            </div>
          </div>
        ) : (
          <SelectAccountForm
            customerIds={customerIds}
            currentCustomerId={account.customer_id}
          />
        )}
      </div>
    </div>
  );
}
