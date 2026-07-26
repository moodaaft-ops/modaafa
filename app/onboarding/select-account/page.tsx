import { redirect } from 'next/navigation';
import { CircleAlert, Layers } from 'lucide-react';
import { createServerClient } from '@/lib/supabase/server';
import { cookies } from 'next/headers';
import { OnboardingProgress } from '../onboarding-progress';
import { readPendingSessionCookie } from '@/lib/auth/google-ads-pending-cookie';
import { decrypt } from '@/lib/crypto';
import { getCustomerMetadataWithFallback } from '@/lib/google-ads/client';
import {
  formatGoogleAdsCustomerId,
  googleAdsAccountDisplayName,
  googleAdsAccountNameMissing,
} from '@/lib/accounts/display';
import { PendingSubmitButton } from '@/lib/ui/pending-submit-button';
import { Alert } from '@/lib/ui/alert';
import { StatusBadge } from '@/lib/ui/status-badge';
import { buttonClasses } from '@/lib/ui/button';
import { cn } from '@/lib/utils';

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
  searchParams?: Promise<{ session?: string; error?: string }>;
}) {
  const params = await searchParams;
  const sessionId = params?.session ?? '';
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login?next=/onboarding/select-account');
  const cookieStore = await cookies();
  const pending =
    (await loadPendingSession(supabase, user.id, sessionId)) ??
    parsePendingSession(readPendingSessionCookie((name) => cookieStore.get(name)?.value));
  const validPending =
    pending && pending.id === sessionId && new Date(pending.expires_at).getTime() > Date.now();

  let customers = ((validPending ? pending?.accessible_customers : []) ?? []).map((customer) => ({
    ...customer,
    customer_id: String(customer.customer_id ?? '').replace(/-/g, ''),
  }));
  if (validPending && pending?.refresh_token_encrypted && customers.some((customer) => !customer.customer_name)) {
    customers = await enrichCustomerNames(customers, pending.refresh_token_encrypted);
  }
  const linkableCount = customers.filter((customer) => !customer.is_manager).length;

  return (
    <main className="min-h-screen bg-background px-4 py-8 sm:px-6">
      <div className="mx-auto max-w-4xl">
        <OnboardingProgress active="accounts" />

        <div className="mb-6 mt-8">
          <h2 className="text-2xl font-bold sm:text-3xl">اختر الحسابات الإعلانية</h2>
          <p className="mt-2 max-w-2xl text-sm leading-7 text-muted-foreground">
            اختر حسابات العملاء غير الإدارية التي تريد إدارتها. تقدر تبدّل بينها لاحقاً من القائمة الجانبية.
          </p>
        </div>

        {params?.error && (
          <div className="mb-5">
            <Alert tone="danger">{errors[params.error] ?? 'حدث خطأ أثناء اختيار الحساب.'}</Alert>
          </div>
        )}

        {!validPending ? (
          <div className="rounded-lg border border-border bg-card p-8 text-center shadow-soft">
            <span className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-lg bg-amber-50 dark:bg-amber-500/15 text-amber-600 dark:text-amber-400">
              <CircleAlert className="h-7 w-7" />
            </span>
            <h3 className="text-xl font-bold">انتهت جلسة الربط</h3>
            <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
              جلسة اختيار الحسابات انتهت صلاحيتها. أعد الربط عبر Google لتظهر حساباتك مرة أخرى.
            </p>
            <a href="/onboarding/connect" className={`${buttonClasses({ variant: 'primary', size: 'lg' })} mt-5`}>
              أعد الربط
            </a>
          </div>
        ) : (
          <form
            action="/api/auth/google-ads/select-account"
            method="post"
            className="overflow-hidden rounded-lg border border-border bg-card shadow-soft"
          >
            <input type="hidden" name="session_id" value={sessionId} />
            <div className="flex flex-wrap items-center gap-2 border-b border-border p-5 text-sm text-muted-foreground">
              <Layers className="h-4 w-4 text-muted-foreground" />
              وجدنا <b className="text-foreground">{customers.length}</b> حساباً، منها
              <b className="text-brand-700 dark:text-brand-300">{linkableCount}</b> حساب عميل قابل للإدارة.
            </div>

            {linkableCount === 0 && (
              <div className="border-b border-amber-100 dark:border-amber-500/25 bg-amber-50 dark:bg-amber-500/15 p-4">
                <Alert tone="warning" icon={false}>
                  الحسابات الإدارية تظهر هنا للمعرفة فقط. اربط حساب عميل غير إداري أو ادخل ببريد يملك حساب إعلانات Google
                  مباشر.
                </Alert>
              </div>
            )}

            <div className="divide-y divide-border">
              {customers.map((customer) => {
                const missing = googleAdsAccountNameMissing(customer);
                return (
                  <label
                    key={customer.customer_id}
                    className={cn(
                      'flex items-start gap-4 p-5 transition',
                      customer.is_manager
                        ? 'bg-muted/60'
                        : 'cursor-pointer hover:bg-muted has-[:checked]:bg-brand-50/50'
                    )}
                  >
                    <input
                      type="checkbox"
                      name="customer_id"
                      value={customer.customer_id}
                      disabled={customer.is_manager}
                      defaultChecked={!customer.is_manager && customers.length === 1}
                      className="mt-1 h-5 w-5 accent-brand-600 disabled:opacity-40"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold text-foreground">{googleAdsAccountDisplayName(customer)}</div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <span dir="ltr">{formatGoogleAdsCustomerId(customer.customer_id)}</span>
                        {customer.manager_id && (
                          <span className="text-muted-foreground">تحت مدير {customer.manager_id}</span>
                        )}
                        {customer.is_manager && <StatusBadge tone="warning">حساب إداري</StatusBadge>}
                        {missing && <StatusBadge tone="neutral">Google لم ترجع اسماً</StatusBadge>}
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-muted/60 p-5">
              <p className="text-xs text-muted-foreground">لن ننفذ أي تعديل على حساباتك قبل موافقتك داخل المنصة.</p>
              <PendingSubmitButton
                disabled={linkableCount === 0}
                pendingLabel="جاري ربط الحسابات..."
                className={buttonClasses({ variant: 'primary', size: 'lg' })}
              >
                ربط الحسابات المختارة
              </PendingSubmitButton>
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

async function loadPendingSession(
  supabase: any,
  userId: string,
  sessionId: string
): Promise<PendingSession | null> {
  if (!sessionId) return null;

  const { data, error } = await supabase
    .from('pending_oauth_sessions')
    .select('id, user_id, refresh_token_encrypted, accessible_customers, expires_at')
    .eq('id', sessionId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    console.error('Failed to load pending Google Ads OAuth session', error);
    return null;
  }

  return (data as PendingSession | null) ?? null;
}

async function enrichCustomerNames(
  customers: PendingCustomer[],
  encryptedRefreshToken: string
): Promise<PendingCustomer[]> {
  let refreshToken: string;
  try {
    refreshToken = decrypt(encryptedRefreshToken);
  } catch {
    return customers;
  }

  const managerCandidates = customers
    .flatMap((customer) => [customer.manager_id, customer.is_manager ? customer.customer_id : null])
    .filter((value): value is string => Boolean(value))
    .map((value) => value.replace(/\D/g, ''))
    .filter((value, index, values) => value && values.indexOf(value) === index);

  return Promise.all(
    customers.map(async (customer) => {
      if (customer.customer_name && customer.currency_code && customer.time_zone) return customer;

      try {
        const normalizedCustomerId = String(customer.customer_id ?? '').replace(/-/g, '');
        const { metadata, loginCustomerId } = await getCustomerMetadataWithFallback(
          refreshToken,
          normalizedCustomerId,
          [customer.manager_id, ...managerCandidates].filter((value): value is string => Boolean(value))
        );

        return {
          ...customer,
          customer_id: metadata.customer_id,
          customer_name: customer.customer_name ?? metadata.customer_name,
          manager_id:
            customer.manager_id ??
            (loginCustomerId && loginCustomerId !== normalizedCustomerId ? loginCustomerId : null),
          is_manager: customer.is_manager ?? metadata.is_manager,
          currency_code: customer.currency_code ?? metadata.currency_code,
          time_zone: customer.time_zone ?? metadata.time_zone,
        };
      } catch (error) {
        console.warn(`Failed to enrich pending Google Ads account ${customer.customer_id}`, error);
        return customer;
      }
    })
  );
}
