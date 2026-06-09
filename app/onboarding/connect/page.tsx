import Link from 'next/link';
import { createServerClient } from '@/lib/supabase/server';

const errors: Record<string, string> = {
  no_accounts: 'لم نجد حسابات Google Ads على هذا المستخدم.',
  state_mismatch: 'انتهت جلسة الربط. أعد المحاولة.',
  oauth_failed: 'فشل إكمال الربط من Google. أعد المحاولة.',
  session_expired: 'انتهت جلسة اختيار الحسابات. أعد الربط.',
};

export default async function ConnectGoogleAdsPage({
  searchParams,
}: {
  searchParams?: { error?: string };
}) {
  const supabase = createServerClient();
  const { data: accounts } = await supabase
    .from('google_ads_accounts')
    .select('customer_id, customer_name, status')
    .order('linked_at', { ascending: false });

  return (
    <main className="min-h-screen bg-ink-50 px-6 py-8">
      <div className="mx-auto max-w-4xl">
        <div className="mb-8">
          <div className="text-sm font-semibold text-brand-700">مُضاعِف</div>
          <h1 className="mt-2 text-3xl font-bold">اربط حساب Google Ads</h1>
          <p className="mt-2 text-sm text-ink-500">
            سيظهر لك كل حساب مباشر وكل حساب عميل تحت أي حساب إداري تملكه، ثم تختار الحسابات التي تريد إدارتها.
          </p>
        </div>

        {searchParams?.error && (
          <div className="mb-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {errors[searchParams.error] ?? 'حدث خطأ أثناء الربط.'}
          </div>
        )}

        <section className="rounded-lg border border-ink-100 bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-xl font-bold">صلاحية Google Ads</h2>
              <p className="mt-1 text-sm text-ink-500">الصلاحية المطلوبة هي قراءة وإدارة Google Ads فقط، وكل تعديل يمر عبر موافقة داخل المنصة.</p>
            </div>
            <a
              href="/api/auth/google-ads/connect"
              className="rounded-lg bg-brand-600 px-6 py-3 text-sm font-semibold text-white hover:bg-brand-700"
            >
              بدء الربط
            </a>
          </div>

          {(accounts?.length ?? 0) > 0 && (
            <div className="mt-6 border-t border-ink-100 pt-5">
              <div className="mb-3 text-sm font-semibold">حسابات مربوطة</div>
              <div className="grid gap-3">
                {(accounts ?? []).map((account) => (
                  <div key={account.customer_id} className="rounded-lg border border-ink-100 px-4 py-3 text-sm">
                    <span className="font-medium">{account.customer_name ?? 'حساب Google Ads'}</span>
                    <span className="mx-2 text-ink-300">·</span>
                    <span dir="ltr">{account.customer_id}</span>
                  </div>
                ))}
              </div>
              <Link href="/dashboard" className="mt-5 inline-block text-sm font-semibold text-brand-700">
                الانتقال للوحة التحكم
              </Link>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
