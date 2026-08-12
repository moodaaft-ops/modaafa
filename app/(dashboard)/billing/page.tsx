import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Check, CreditCard, ReceiptText } from 'lucide-react';
import { createServerClient } from '@/lib/supabase/server';
import { assertSupabaseRead } from '@/lib/supabase/query-errors';
import { cn, formatCurrency, formatDateAr } from '@/lib/utils';
import { planLabel, subscriptionStatusLabel } from '@/lib/ui/labels';
import { PendingSubmitButton } from '@/lib/ui/pending-submit-button';
import { PageHeader } from '@/lib/ui/page-header';
import { Alert } from '@/lib/ui/alert';
import { StatusBadge } from '@/lib/ui/status-badge';
import { EmptyState } from '@/lib/ui/empty-state';
import { buttonClasses } from '@/lib/ui/button';
import { getBillingCheckoutContext } from '@/lib/billing/checkout-policy';
import { getSubscriptionAccess } from '@/lib/billing/entitlements';
import { getPlanPriceAmounts, type PeriodKey, type PlanKey } from '@/lib/billing/stripe';

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
    id: 'starter' as PlanKey,
    name: 'البداية',
    nameEn: 'Starter',
    monthlyPrice: 500,
    limit: 'للبداية وإدارة العمل اليومي',
    features: ['20 محادثة ذكية يومياً', 'فحصان أسبوعياً', '5 مزامنات يدوية يومياً'],
  },
  {
    id: 'growth' as PlanKey,
    name: 'النمو',
    nameEn: 'Growth',
    monthlyPrice: 1200,
    limit: 'للشركات النشطة والمتابعة اليومية',
    features: ['100 محادثة ذكية يومياً', '7 فحوصات أسبوعياً', '20 تنفيذاً ومزامنة يومياً'],
    highlighted: true,
  },
  {
    id: 'pro' as PlanKey,
    name: 'الاحتراف',
    nameEn: 'Pro',
    monthlyPrice: 2500,
    limit: 'للوكالات والاستخدام المكثف',
    features: ['500 محادثة ذكية يومياً', '70 فحصاً أسبوعياً', '100 تنفيذ ومزامنة يومياً'],
  },
];

const PLAN_IDS: readonly string[] = ['starter', 'growth', 'pro'];

export const metadata = {
  title: 'الاشتراك والفوترة',
};

export default async function BillingPage({
  searchParams,
}: {
  searchParams?: Promise<{ error?: string; canceled?: string; plan?: string; period?: string }>;
}) {
  const params = await searchParams;
  const period: PeriodKey = params?.period === 'yearly' ? 'yearly' : 'monthly';
  // The landing page carries the visitor's chosen plan through login
  // (`/billing?plan=…`); consume it so they land on a highlighted card, not a
  // bare pricing table that forgot their choice.
  const chosenPlan = params?.plan && PLAN_IDS.includes(params.plan) ? (params.plan as PlanKey) : null;

  const supabase = await createServerClient();
  // Every query below is scoped to `user.id` explicitly. RLS already does this,
  // but billing is the wrong place to have exactly one line of defence: a
  // future switch to the admin client, or RLS disabled during an incident,
  // would turn each of these into a cross-tenant read with no second check.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login?next=/billing');

  // One shared policy for eligibility and entitlement — this page previously
  // re-implemented both and got both wrong: trial eligibility skipped the
  // durable email ledger (promising a trial checkout would then deny), and
  // "current plan" took the newest row, the exact heuristic entitlements.ts
  // documents as showing a paying customer "no active subscription".
  const [access, checkout, invoicesResult, priceAmounts] = await Promise.all([
    getSubscriptionAccess(supabase, user.id),
    getBillingCheckoutContext(supabase, user.id, user.email),
    supabase
      .from('invoices')
      .select('invoice_number, amount_sar, currency, status, invoice_url, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(5),
    getPlanPriceAmounts(),
  ]);

  assertSupabaseRead(invoicesResult.error, 'load billing invoices');
  const invoices = invoicesResult.data ?? [];
  const trialEligible = checkout.trialEligible;
  const hasLiveSubscription = Boolean(checkout.activeSubscriptionId);
  const currentPlan = hasLiveSubscription ? access.plan : null;

  const buildHref = (nextPeriod: PeriodKey) => {
    const query = new URLSearchParams();
    if (nextPeriod === 'yearly') query.set('period', 'yearly');
    if (chosenPlan) query.set('plan', chosenPlan);
    const qs = query.toString();
    return qs ? `/billing?${qs}` : '/billing';
  };

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
              <div className="text-[11px] font-medium uppercase text-foreground-subtle">
                الخطة الحالية
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2.5 text-[26px] font-bold leading-none">
                {currentPlan ? planLabel(currentPlan) : 'لا يوجد اشتراك نشط'}
                {hasLiveSubscription && access.status && (
                  <StatusBadge tone={access.status === 'active' ? 'success' : 'warning'}>
                    {subscriptionStatusLabel(access.status)}
                  </StatusBadge>
                )}
              </div>
              <p className="mt-2 text-[13px] text-muted-foreground">
                {/* The trial line is gated on the LIVE status: Stripe keeps
                    `trial_end` set forever after a trial converts, so keying on
                    the timestamp showed "تنتهي التجربة في <تاريخ ماضٍ>" to every
                    paying customer instead of their renewal date. */}
                {access.status === 'trialing' && access.trialEndsAt
                  ? `تنتهي التجربة في ${formatDateAr(access.trialEndsAt)}`
                  : hasLiveSubscription && access.currentPeriodEnd
                    ? `تجديد الاشتراك في ${formatDateAr(access.currentPeriodEnd)}`
                    : 'اختر خطة بالأسفل لتفعيل الفحص والتنفيذ والمساعد الذكي.'}
              </p>
            </div>
            {hasLiveSubscription && checkout.stripeCustomerId ? (
              <form action="/api/billing/portal" method="post">
                <PendingSubmitButton pendingLabel="جاري فتح Stripe..." className={buttonClasses({ variant: 'secondary' })}>
                  إدارة الاشتراك في Stripe
                </PendingSubmitButton>
              </form>
            ) : !hasLiveSubscription ? (
              <form action="/api/billing/checkout" method="post">
                <input type="hidden" name="plan" value="growth" />
                <input type="hidden" name="period" value={period} />
                <PendingSubmitButton pendingLabel="جاري فتح الدفع..." className={buttonClasses({ variant: 'secondary' })}>
                  {trialEligible ? 'ابدأ تجربة خطة النمو' : 'اشترك في خطة النمو'}
                </PendingSubmitButton>
              </form>
            ) : null}
          </div>
        </section>

        {/* Billing period toggle — the six Stripe prices include yearly slots
            that were configured, enforced by the readiness check, and
            impossible to buy: every form hardcoded `period=monthly`. */}
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-[15px] font-semibold">الخطط المتاحة</h2>
          <div className="inline-flex items-center rounded-lg border border-border bg-background-elevated p-1 text-[13px]" role="group" aria-label="فترة الفوترة">
            <Link
              href={buildHref('monthly')}
              aria-current={period === 'monthly' ? 'true' : undefined}
              className={cn(
                'rounded-md px-3.5 py-1.5 font-medium transition-colors',
                period === 'monthly' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              شهري
            </Link>
            <Link
              href={buildHref('yearly')}
              aria-current={period === 'yearly' ? 'true' : undefined}
              className={cn(
                'rounded-md px-3.5 py-1.5 font-medium transition-colors',
                period === 'yearly' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              سنوي
            </Link>
          </div>
        </div>

        {/* Plans */}
        <div className="grid gap-4 lg:grid-cols-3">
          {plans.map((plan) => {
            const isCurrent = currentPlan === plan.id;
            const isChosen = chosenPlan === plan.id && !isCurrent;
            const livePrice = priceAmounts?.[plan.id]?.[period] ?? null;
            const displayAmount = livePrice?.amount ?? (period === 'monthly' ? plan.monthlyPrice : null);
            const displayCurrency = (livePrice?.currency ?? 'sar').toUpperCase();
            const monthlyAmount = priceAmounts?.[plan.id]?.monthly?.amount ?? plan.monthlyPrice;
            const yearlySavings =
              period === 'yearly' && livePrice && displayCurrency === 'SAR'
                ? Math.max(0, monthlyAmount * 12 - livePrice.amount)
                : 0;

            return (
              <section
                key={plan.id}
                className={cn(
                  'relative flex flex-col overflow-hidden p-6',
                  plan.highlighted ? 'surface-raised border-primary/35' : 'surface-card',
                  isChosen && 'ring-1 ring-primary/60'
                )}
              >
                {/* One hairline of colour marks the recommended plan — no
                    glow, no double ring. */}
                {plan.highlighted && <span className="absolute inset-x-0 top-0 h-px bg-primary" aria-hidden />}

                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="text-[17px] font-semibold">{plan.name}</h2>
                    <p className="mt-0.5 text-[11px] font-medium uppercase text-foreground-subtle" dir="ltr">
                      {plan.nameEn}
                    </p>
                  </div>
                  {isCurrent ? (
                    <StatusBadge tone="success">خطتك الحالية</StatusBadge>
                  ) : isChosen ? (
                    <StatusBadge tone="brand">اختيارك</StatusBadge>
                  ) : plan.highlighted ? (
                    <StatusBadge tone="brand">الأنسب</StatusBadge>
                  ) : null}
                </div>

                <p className="mt-2 text-[13px] leading-6 text-muted-foreground">{plan.limit}</p>

                <div className="mt-5 flex items-baseline gap-1.5">
                  {displayAmount !== null ? (
                    <>
                      <span className="text-[2rem] font-bold leading-none numeric">
                        {formatCurrency(displayAmount, displayCurrency)}
                      </span>
                      <span className="text-[13px] text-muted-foreground">
                        / {period === 'yearly' ? 'سنة' : 'شهر'}
                      </span>
                    </>
                  ) : (
                    <span className="text-[14px] font-semibold leading-6 text-muted-foreground">
                      فوترة سنوية — يظهر المبلغ النهائي في صفحة الدفع
                    </span>
                  )}
                </div>
                {yearlySavings > 0 && (
                  <p className="mt-1.5 text-[12px] font-medium text-emerald-500">
                    وفّر {formatCurrency(yearlySavings, 'SAR')} مقارنة بالدفع الشهري
                  </p>
                )}

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
                  ) : hasLiveSubscription ? (
                    /* Plan changes for live subscribers go through the Stripe
                       portal. The old button posted to /api/billing/checkout,
                       which unconditionally rejects live subscribers with
                       `already_subscribed` — every switch click dead-ended in
                       an error banner. */
                    <form action="/api/billing/portal" method="post">
                      <PendingSubmitButton
                        pendingLabel="جاري فتح Stripe..."
                        className={buttonClasses({
                          variant: plan.highlighted ? 'primary' : 'secondary',
                          block: true,
                        })}
                      >
                        التبديل عبر بوابة Stripe
                      </PendingSubmitButton>
                    </form>
                  ) : (
                    <form action="/api/billing/checkout" method="post">
                      <input type="hidden" name="plan" value={plan.id} />
                      <input type="hidden" name="period" value={period} />
                      <PendingSubmitButton
                        pendingLabel="جاري فتح الدفع..."
                        className={buttonClasses({
                          variant: plan.highlighted || isChosen ? 'primary' : 'secondary',
                          block: true,
                        })}
                      >
                        {trialEligible ? 'ابدأ تجربة 14 يوم' : 'اشترك الآن'}
                      </PendingSubmitButton>
                    </form>
                  )}
                  <p className="text-center text-[11px] leading-5 text-foreground-subtle">
                    {hasLiveSubscription && !isCurrent
                      ? 'تغيير الخطة يتم داخل بوابة Stripe ويُحتسب الفرق تلقائياً.'
                      : trialEligible
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
            <h2 className="text-[14px] font-semibold">آخر الفواتير</h2>
            <p className="mt-1 text-xs text-muted-foreground">آخر 5 فواتير صادرة على هذا الحساب.</p>
          </div>
          {invoices.length === 0 ? (
            <EmptyState
              bare
              tone="neutral"
              icon={ReceiptText}
              title="لا توجد فواتير بعد"
              description="أول فاتورة تظهر هنا بعد انتهاء التجربة وبدء أول دورة فوترة. الفواتير تُصدَر وتُحفظ عبر Stripe."
            />
          ) : (
            <div className="divide-y divide-border">
              {invoices.map((invoice: any) => (
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
