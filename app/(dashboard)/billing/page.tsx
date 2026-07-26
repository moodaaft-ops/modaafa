import { Check, CreditCard } from 'lucide-react';
import { createServerClient } from '@/lib/supabase/server';
import { formatSAR } from '@/lib/utils';
import { planLabel, subscriptionStatusLabel } from '@/lib/ui/labels';
import { PendingSubmitButton } from '@/lib/ui/pending-submit-button';
import { PageHeader } from '@/lib/ui/page-header';
import { Alert } from '@/lib/ui/alert';
import { StatusBadge } from '@/lib/ui/status-badge';
import { buttonClasses } from '@/lib/ui/button';
import { cn } from '@/lib/utils';

const billingErrors: Record<string, string> = {
  already_subscribed: 'لديك اشتراك قائم بالفعل. استخدم زر إدارة الاشتراك لتغيير الخطة أو وسيلة الدفع.',
  no_stripe_customer: 'لم نجد ملف فوترة مرتبطاً بهذا الحساب.',
  portal_failed: 'تعذر فتح بوابة إدارة الاشتراك الآن. أعد المحاولة بعد قليل.',
  invalid_session: 'جلسة الدفع غير صالحة أو لا تخص هذا الحساب.',
  subscription_missing: 'اكتملت جلسة الدفع لكن لم يصلنا رقم الاشتراك. لم يتم تفعيل الخطة بعد.',
  activation_failed: 'اكتمل الدفع لكن تعذر تأكيد التفعيل فوراً. سنعيد المزامنة تلقائياً، ويمكنك تحديث الصفحة.',
  checkout_failed: 'تعذر إنشاء جلسة الدفع. لم يتم خصم أي مبلغ.',
  too_many_requests: 'تم طلب بوابة الفوترة عدة مرات خلال فترة قصيرة. انتظر دقيقة ثم أعد المحاولة.',
  security_service_unavailable: 'تعذر التحقق الآمن من طلب الفوترة الآن. أعد المحاولة بعد قليل.',
};

const plans = [
  {
    id: 'starter',
    name: 'البداية',
    nameEn: 'Starter',
    price: 500,
    limit: 'للبداية وإدارة العمل اليومي',
    features: ['20 محادثة ذكية يومياً', 'فحصان أسبوعياً', '5 مزامنات يدوية يومياً'],
  },
  {
    id: 'growth',
    name: 'النمو',
    nameEn: 'Growth',
    price: 1200,
    limit: 'للشركات النشطة والمتابعة اليومية',
    features: ['100 محادثة ذكية يومياً', '7 فحوصات أسبوعياً', '20 تنفيذاً ومزامنة يومياً'],
    highlighted: true,
  },
  {
    id: 'pro',
    name: 'الاحتراف',
    nameEn: 'Pro',
    price: 2500,
    limit: 'للوكالات والاستخدام المكثف',
    features: ['500 محادثة ذكية يومياً', '70 فحصاً أسبوعياً', '100 تنفيذ ومزامنة يومياً'],
  },
];

export const metadata = {
  title: 'الاشتراك والفوترة',
};

export default async function BillingPage({
  searchParams,
}: {
  searchParams?: Promise<{ error?: string; canceled?: string }>;
}) {
  const params = await searchParams;
  const supabase = await createServerClient();
  const { data: subscription } = await supabase
    .from('subscriptions')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const [{ data: trialGrant, error: trialGrantError }, { data: priorTrial, error: priorTrialError }] =
    await Promise.all([
      supabase.from('billing_trial_grants').select('user_id').limit(1).maybeSingle(),
      supabase.from('subscriptions').select('id').not('trial_ends_at', 'is', null).limit(1).maybeSingle(),
    ]);
  const trialEligible = !trialGrantError && !priorTrialError && !trialGrant && !priorTrial;
  const hasLiveSubscription = Boolean(
    subscription && ['trialing', 'active', 'past_due', 'paused'].includes(subscription.status)
  );
  const { data: invoices } = await supabase
    .from('invoices')
    .select('invoice_number, amount_sar, status, invoice_url, created_at')
    .order('created_at', { ascending: false })
    .limit(5);

  return (
    <>
      <PageHeader icon={CreditCard} title="الفوترة والاشتراك" description="إدارة الخطة والتجربة والفواتير." />

      <div className="space-y-6 p-4 sm:p-6 lg:p-8">
        {params?.error && (
          <Alert tone="danger">
            {billingErrors[params.error] ?? 'تعذر تنفيذ عملية الفوترة. لم يتم خصم أي مبلغ.'}
          </Alert>
        )}
        {params?.canceled && <Alert tone="warning">تم إلغاء عملية الدفع ولم يتغيّر اشتراكك.</Alert>}

        {/* Current plan */}
        <section className="rounded-lg border border-border bg-card p-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <div className="text-sm text-muted-foreground">الخطة الحالية</div>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-2xl font-bold">
                {subscription ? planLabel(subscription.plan) : 'لا يوجد اشتراك نشط'}
                {subscription && (
                  <StatusBadge tone={subscription.status === 'active' ? 'success' : 'warning'}>
                    {subscriptionStatusLabel(subscription.status)}
                  </StatusBadge>
                )}
              </div>
              {subscription?.trial_ends_at && (
                <p className="mt-1 text-sm text-muted-foreground">
                  تنتهي التجربة في {new Date(subscription.trial_ends_at).toLocaleDateString('ar-SA')}
                </p>
              )}
            </div>
            {hasLiveSubscription && subscription?.stripe_customer_id ? (
              <form action="/api/billing/portal" method="post">
                <PendingSubmitButton pendingLabel="جاري فتح Stripe..." className={buttonClasses({ variant: 'secondary' })}>
                  إدارة الاشتراك في Stripe
                </PendingSubmitButton>
              </form>
            ) : !hasLiveSubscription ? (
              <form action="/api/billing/checkout" method="post">
                <input type="hidden" name="plan" value="growth" />
                <input type="hidden" name="period" value="monthly" />
                <PendingSubmitButton pendingLabel="جاري فتح الدفع..." className={buttonClasses({ variant: 'secondary' })}>
                  {trialEligible ? 'ابدأ تجربة النمو / Growth' : 'اشترك في النمو / Growth'}
                </PendingSubmitButton>
              </form>
            ) : null}
          </div>
        </section>

        {/* Plans */}
        <div className="grid gap-4 lg:grid-cols-3">
          {plans.map((plan) => (
            <section
              key={plan.id}
              className={cn(
                'flex flex-col rounded-lg border bg-card p-6',
                plan.highlighted ? 'border-brand-500 shadow-card ring-1 ring-brand-100 dark:ring-brand-500/30' : 'border-border'
              )}
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-xl font-bold">{plan.name}</h2>
                  <p className="text-xs font-medium text-muted-foreground" dir="ltr">
                    {plan.nameEn}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">{plan.limit}</p>
                </div>
                {plan.highlighted && <StatusBadge tone="brand">الأنسب</StatusBadge>}
              </div>
              <div className="mt-5 text-3xl font-bold tabular-nums">
                {formatSAR(plan.price)}
                <span className="text-sm font-normal text-muted-foreground"> / شهر</span>
              </div>
              <ul className="mt-5 flex-1 space-y-2.5 text-sm text-muted-foreground">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex items-center gap-2">
                    <Check className="h-4 w-4 flex-shrink-0 text-emerald-500" />
                    {feature}
                  </li>
                ))}
              </ul>
              <div className="mt-6 grid gap-2">
                <form action="/api/billing/checkout" method="post">
                  <input type="hidden" name="plan" value={plan.id} />
                  <input type="hidden" name="period" value="monthly" />
                  <PendingSubmitButton
                    pendingLabel="جاري فتح الدفع..."
                    className={buttonClasses({ variant: 'primary', block: true })}
                  >
                    {trialEligible ? 'ابدأ تجربة 14 يوم' : 'اشترك الآن'}
                  </PendingSubmitButton>
                </form>
                <p className="text-center text-xs leading-6 text-muted-foreground">
                  {trialEligible
                    ? 'لن يتم الخصم خلال فترة التجربة. إدارة البطاقة والفواتير تتم بأمان عبر Stripe.'
                    : 'تبدأ الفوترة عند تأكيد الاشتراك. إدارة البطاقة والفواتير تتم بأمان عبر Stripe.'}
                </p>
              </div>
            </section>
          ))}
        </div>

        {/* Invoices */}
        <section className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="border-b border-border p-5 font-bold">آخر الفواتير</div>
          {(invoices ?? []).length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground">لا توجد فواتير محفوظة بعد.</div>
          ) : (
            <div className="divide-y divide-border">
              {(invoices ?? []).map((invoice: any) => (
                <div
                  key={`${invoice.invoice_number}-${invoice.created_at}`}
                  className="flex items-center justify-between gap-4 p-5 text-sm"
                >
                  <div>
                    <div className="font-semibold text-foreground">{invoice.invoice_number ?? 'فاتورة'}</div>
                    <div className="mt-1 text-xs text-muted-foreground">{subscriptionStatusLabel(invoice.status)}</div>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className="font-bold tabular-nums">{formatSAR(invoice.amount_sar ?? 0)}</span>
                    {invoice.invoice_url && (
                      <a href={invoice.invoice_url} className="font-semibold text-brand-700 dark:text-brand-300 hover:underline" target="_blank">
                        عرض
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </>
  );
}
