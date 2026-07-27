import { Check, CreditCard, ReceiptText } from 'lucide-react';
import { createServerClient } from '@/lib/supabase/server';
import { formatCurrency, formatDateAr, formatSAR } from '@/lib/utils';
import { planLabel, subscriptionStatusLabel } from '@/lib/ui/labels';
import { PendingSubmitButton } from '@/lib/ui/pending-submit-button';
import { PageHeader } from '@/lib/ui/page-header';
import { Alert } from '@/lib/ui/alert';
import { StatusBadge } from '@/lib/ui/status-badge';
import { EmptyState } from '@/lib/ui/empty-state';
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
  // Every query below is scoped to `user.id` explicitly. RLS already does this,
  // but billing is the wrong place to have exactly one line of defence: a
  // future switch to the admin client, or RLS disabled during an incident,
  // would turn each of these into a cross-tenant read with no second check.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const userId = user?.id ?? null;

  const { data: subscription } = userId
    ? await supabase
        .from('subscriptions')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
    : { data: null };
  const [{ data: trialGrant, error: trialGrantError }, { data: priorTrial, error: priorTrialError }] = userId
    ? await Promise.all([
        supabase.from('billing_trial_grants').select('user_id').eq('user_id', userId).limit(1).maybeSingle(),
        supabase
          .from('subscriptions')
          .select('id')
          .eq('user_id', userId)
          .not('trial_ends_at', 'is', null)
          .limit(1)
          .maybeSingle(),
      ])
    : [{ data: null, error: null }, { data: null, error: null }];
  const trialEligible = !trialGrantError && !priorTrialError && !trialGrant && !priorTrial;
  const hasLiveSubscription = Boolean(
    subscription && ['trialing', 'active', 'past_due', 'paused'].includes(subscription.status)
  );
  const { data: invoices } = userId
    ? await supabase
        .from('invoices')
        .select('invoice_number, amount_sar, currency, status, invoice_url, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(5)
    : { data: [] };

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
        <section className="surface-raised relative overflow-hidden p-6">
          <div className="canvas-glow pointer-events-none absolute inset-0 opacity-50" aria-hidden />
          <div className="relative flex flex-wrap items-center justify-between gap-4">
            <div>
              <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-foreground-subtle">
                الخطة الحالية
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2.5 text-[26px] font-bold leading-none tracking-tight">
                {subscription ? planLabel(subscription.plan) : 'لا يوجد اشتراك نشط'}
                {subscription && (
                  <StatusBadge tone={subscription.status === 'active' ? 'success' : 'warning'}>
                    {subscriptionStatusLabel(subscription.status)}
                  </StatusBadge>
                )}
              </div>
              <p className="mt-2 text-[13px] text-muted-foreground">
                {subscription?.trial_ends_at
                  ? `تنتهي التجربة في ${formatDateAr(subscription.trial_ends_at)}`
                  : subscription?.current_period_end
                    ? `تجديد الاشتراك في ${formatDateAr(subscription.current_period_end)}`
                    : 'اختر خطة بالأسفل لتفعيل الفحص والتنفيذ والمساعد الذكي.'}
              </p>
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
          {plans.map((plan) => {
            const isCurrent = subscription?.plan === plan.id && hasLiveSubscription;
            return (
              <section
                key={plan.id}
                className={cn(
                  'relative flex flex-col overflow-hidden p-6',
                  plan.highlighted ? 'surface-raised border-primary/35' : 'surface-card'
                )}
              >
                {/* One hairline of colour marks the recommended plan — no
                    glow, no double ring. */}
                {plan.highlighted && <span className="absolute inset-x-0 top-0 h-px bg-primary" aria-hidden />}

                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="text-[17px] font-semibold tracking-tight">{plan.name}</h2>
                    <p className="mt-0.5 text-[11px] font-medium uppercase tracking-wide text-foreground-subtle" dir="ltr">
                      {plan.nameEn}
                    </p>
                  </div>
                  {isCurrent ? (
                    <StatusBadge tone="success">خطتك الحالية</StatusBadge>
                  ) : plan.highlighted ? (
                    <StatusBadge tone="brand">الأنسب</StatusBadge>
                  ) : null}
                </div>

                <p className="mt-2 text-[13px] leading-6 text-muted-foreground">{plan.limit}</p>

                <div className="mt-5 flex items-baseline gap-1.5">
                  <span className="text-[2rem] font-bold leading-none tracking-tight numeric">
                    {formatSAR(plan.price)}
                  </span>
                  <span className="text-[13px] text-muted-foreground">/ شهر</span>
                </div>

                <div className="rule-fade my-5 h-px" aria-hidden />

                <ul className="flex-1 space-y-2.5 text-[13px] text-muted-foreground">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex items-start gap-2.5 leading-6">
                      <Check className="mt-1 h-3.5 w-3.5 flex-shrink-0 text-emerald-500" />
                      {feature}
                    </li>
                  ))}
                </ul>

                <div className="mt-6 grid gap-2.5">
                  {isCurrent ? (
                    <form action="/api/billing/portal" method="post">
                      <PendingSubmitButton
                        pendingLabel="جاري فتح Stripe..."
                        className={buttonClasses({ variant: 'outline', block: true })}
                      >
                        إدارة هذه الخطة
                      </PendingSubmitButton>
                    </form>
                  ) : (
                    <form action="/api/billing/checkout" method="post">
                      <input type="hidden" name="plan" value={plan.id} />
                      <input type="hidden" name="period" value="monthly" />
                      <PendingSubmitButton
                        pendingLabel="جاري فتح الدفع..."
                        className={buttonClasses({
                          variant: plan.highlighted ? 'primary' : 'secondary',
                          block: true,
                        })}
                      >
                        {hasLiveSubscription ? 'التبديل لهذه الخطة' : trialEligible ? 'ابدأ تجربة 14 يوم' : 'اشترك الآن'}
                      </PendingSubmitButton>
                    </form>
                  )}
                  <p className="text-center text-[11px] leading-5 text-foreground-subtle">
                    {trialEligible
                      ? 'لن يتم الخصم خلال فترة التجربة. البطاقة والفواتير تُدار بأمان عبر Stripe.'
                      : 'تبدأ الفوترة عند التأكيد. البطاقة والفواتير تُدار بأمان عبر Stripe.'}
                  </p>
                </div>
              </section>
            );
          })}
        </div>

        {/* Invoices */}
        <section className="surface-card overflow-hidden">
          <div className="border-b border-border px-5 py-4">
            <h2 className="text-[14px] font-semibold tracking-tight">آخر الفواتير</h2>
            <p className="mt-1 text-xs text-muted-foreground">آخر 5 فواتير صادرة على هذا الحساب.</p>
          </div>
          {(invoices ?? []).length === 0 ? (
            <EmptyState
              bare
              tone="neutral"
              icon={ReceiptText}
              title="لا توجد فواتير بعد"
              description="أول فاتورة تظهر هنا بعد انتهاء التجربة وبدء أول دورة فوترة. الفواتير تُصدَر وتُحفظ عبر Stripe."
            />
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
                    <span className="font-bold numeric">
                      {formatCurrency(invoice.amount_sar ?? 0, invoice.currency ?? 'SAR')}
                    </span>
                    {invoice.invoice_url && (
                      <a href={invoice.invoice_url} className="font-semibold text-primary hover:underline" target="_blank">
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
