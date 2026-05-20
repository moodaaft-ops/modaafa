import { redirect } from 'next/navigation';
import { createServerClient } from '@/lib/supabase/server';
import { listAccessibleCustomers } from '@/lib/google-ads/client';
import { decrypt } from '@/lib/crypto';
import SelectAccountForm from './select-form';

/**
 * Account selection page.
 *
 * Reads the user's google_ads_accounts row (pending or active), decrypts
 * the refresh token, lists accessible customers, and lets the user pick
 * which one to link. Reachable from:
 *   - OAuth callback (initial linking — row is 'pending')
 *   - /settings (manual switch — row is 'active')
 */
export default async function SelectAccountPage() {
  const supabase = createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // Look for any row — prefer 'pending' (fresh OAuth) over 'active' (existing link)
  const { data: pendingAccount } = await supabase
    .from('google_ads_accounts')
    .select('id, customer_id, refresh_token_encrypted')
    .eq('status', 'pending')
    .limit(1)
    .maybeSingle();

  const { data: activeAccount } = await supabase
    .from('google_ads_accounts')
    .select('id, customer_id, refresh_token_encrypted')
    .eq('status', 'active')
    .limit(1)
    .maybeSingle();

  const account = pendingAccount ?? activeAccount;
  const isPending = !!pendingAccount;

  if (!account) {
    // Nothing in DB — user needs to OAuth first
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

  // currentCustomerId is only meaningful when we have an ACTIVE link.
  // On first-time linking (pending), pass empty so nothing shows as "current".
  const currentCustomerId = isPending ? '' : account.customer_id;

  const subtitle = isPending
    ? customerIds.length > 1
      ? `وجدنا ${customerIds.length} حساب — اختر اللي تبي تربطه بـ مُضاعِف`
      : 'تأكد من الحساب اللي تبي تربطه'
    : customerIds.length > 0
      ? `يمكنك تبديل الحساب المرتبط حالياً من القائمة`
      : 'اختر الحساب الإعلاني';

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-ink-50 to-brand-50 p-4">
      <div className="w-full max-w-xl bg-white rounded-3xl shadow-xl p-8 md:p-10">
        <div className="text-center mb-8">
          <div className="inline-flex w-16 h-16 rounded-2xl bg-gradient-to-br from-brand-500 to-cyan-500 items-center justify-center text-white text-3xl font-bold mb-4">
            ×
          </div>
          <h1 className="text-2xl font-bold mb-1">اختر حساب Google Ads</h1>
          <p className="text-ink-500 text-sm">{subtitle}</p>
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
            currentCustomerId={currentCustomerId}
            isPending={isPending}
          />
        )}
      </div>
    </div>
  );
}
