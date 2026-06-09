import { createServerClient } from '@/lib/supabase/server';
import { cookies } from 'next/headers';

type PendingCustomer = {
  customer_id: string;
  customer_name?: string | null;
  manager_id?: string | null;
  is_manager?: boolean;
  status?: string | null;
  currency_code?: string | null;
  time_zone?: string | null;
};

type PendingSession = {
  id: string;
  user_id: string;
  refresh_token_encrypted: string;
  accessible_customers: PendingCustomer[];
  expires_at: string;
};

const errors: Record<string, string> = {
  select_required: 'اختر حساباً إعلانياً واحداً على الأقل.',
  manager_only: 'حسابات المدير تظهر للهيكلة فقط. اختر حساب عميل غير إداري.',
  db_error: 'تعذر حفظ الحسابات المختارة. أعد المحاولة.',
};

export default async function SelectAccountPage({
  searchParams,
}: {
  searchParams?: { session?: string; error?: string };
}) {
  const sessionId = searchParams?.session ?? '';
  const supabase = createServerClient();
  await supabase.auth.getUser();
  const pending = parsePendingSession(cookies().get('gads_pending_session')?.value);
  const validPending =
    pending &&
    pending.id === sessionId &&
    new Date(pending.expires_at).getTime() > Date.now();

  const customers = ((validPending ? pending?.accessible_customers : []) ?? []).map((customer) => ({
    ...customer,
    customer_id: String(customer.customer_id ?? '').replace(/-/g, ''),
  }));
  const linkableCount = customers.filter((customer) => !customer.is_manager).length;

  return (
    <main className="min-h-screen bg-ink-50 px-6 py-8">
      <div className="mx-auto max-w-5xl">
        <div className="mb-8">
          <div className="text-sm font-semibold text-brand-700">مُضاعِف</div>
          <h1 className="mt-2 text-3xl font-bold">اختر الحسابات الإعلانية</h1>
          <p className="mt-2 text-sm text-ink-500">اختر حسابات العملاء غير الإدارية التي تريد إدارتها داخل المنصة.</p>
        </div>

        {searchParams?.error && (
          <div className="mb-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {errors[searchParams.error] ?? 'حدث خطأ أثناء اختيار الحساب.'}
          </div>
        )}

        {!validPending ? (
          <div className="rounded-lg border border-ink-100 bg-white p-8 text-center shadow-sm">
            <h2 className="text-xl font-bold">انتهت جلسة الربط</h2>
            <a href="/onboarding/connect" className="mt-5 inline-block rounded-lg bg-brand-600 px-6 py-3 text-sm font-semibold text-white">
              أعد الربط
            </a>
          </div>
        ) : (
          <form action="/api/auth/google-ads/select-account" method="post" className="rounded-lg border border-ink-100 bg-white shadow-sm">
            <input type="hidden" name="session_id" value={sessionId} />
            <div className="border-b border-ink-100 p-5 text-sm text-ink-500">
              وجدنا {customers.length} حساباً، منها {linkableCount} حساب عميل قابل للإدارة.
            </div>
            <div className="divide-y divide-ink-100">
              {customers.map((customer) => (
                <label
                  key={customer.customer_id}
                  className={`flex items-center gap-4 p-5 ${customer.is_manager ? 'bg-ink-50 text-ink-400' : 'cursor-pointer hover:bg-ink-50'}`}
                >
                  <input
                    type="checkbox"
                    name="customer_id"
                    value={customer.customer_id}
                    disabled={customer.is_manager}
                    defaultChecked={!customer.is_manager && customers.length === 1}
                    className="h-5 w-5"
                  />
                  <div className="flex-1">
                    <div className="font-semibold text-ink-900">{customer.customer_name ?? 'حساب Google Ads'}</div>
                    <div className="mt-1 flex flex-wrap gap-2 text-xs text-ink-500">
                      <span dir="ltr">{customer.customer_id}</span>
                      {customer.manager_id && <span>تحت مدير {customer.manager_id}</span>}
                      {customer.is_manager && <span className="rounded bg-amber-100 px-2 py-0.5 text-amber-700">حساب إداري</span>}
                    </div>
                  </div>
                </label>
              ))}
            </div>
            <div className="flex justify-end border-t border-ink-100 p-5">
              <button className="rounded-lg bg-brand-600 px-6 py-3 text-sm font-semibold text-white hover:bg-brand-700">
                ربط الحسابات المختارة
              </button>
            </div>
          </form>
        )}
      </div>
    </main>
  );
}

function parsePendingSession(value?: string): PendingSession | null {
  if (!value) return null;
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}
