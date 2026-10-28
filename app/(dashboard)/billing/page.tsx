import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Check } from 'lucide-react';
import { getRequestAuthContext } from '@/lib/supabase/server';
import { assertSupabaseRead } from '@/lib/supabase/query-errors';
import { cn, formatCurrency, formatDateAr } from '@/lib/utils';
import { planLabel, subscriptionStatusLabel } from '@/lib/ui/labels';
import { PendingSubmitButton } from '@/lib/ui/pending-submit-button';
import { CARD, CalmHeading, CalmNote, CalmPage, CalmTitle, StatusWord, Tag, pill } from '../calm-page';
import { getBillingCheckoutContext } from '@/lib/billing/checkout-policy';
import { ARABIC_CHECKOUT_PATH, isArabicCheckoutAvailable } from '@/lib/billing/arabic-checkout/flag';
import {
  ADS_ACCOUNT_TRIAL_USED_MESSAGE,
  CARD_TRIAL_USED_MESSAGE,
  TRIAL_CHECK_FAILED_MESSAGE,
  TRIAL_STARTER_LIMITS_NOTE,
  trialIneligibleNotice,
} from '@/lib/billing/trial-copy';
import { OPTIMIZER_ACCOUNTS_PER_PLAN, optimizerAccountsLine } from '@/lib/billing/optimizer-caps';
import { hasActiveGoogleAdsAccount } from '@/lib/accounts/selection';
import { getSubscriptionAccessDetailed } from '@/lib/billing/entitlements';
import {
  getPlanPriceAmounts,
  retrieveStripeSubscription,
  type PeriodKey,
  type PlanKey,
} from '@/lib/billing/stripe';

const billingErrors: Record<string, string> = {
  already_subscribed: 'لديك اشتراك قائم بالفعل. استخدم زر إدارة الاشتراك لتغيير الخطة أو وسيلة الدفع.',
  no_stripe_customer: 'لم نجد ملف فوترة مرتبطاً بهذا الحساب.',
  portal_failed: 'تعذر فتح بوابة إدارة الاشتراك الآن. أعد المحاولة بعد قليل.',
  invalid_session: 'جلسة الدفع غير صالحة أو لا تخص هذا الحساب.',
  subscription_missing: 'اكتملت جلسة الدفع لكن لم يصلنا رقم الاشتراك. لم يتم تفعيل الخطة بعد.',
  activation_failed: 'اكتمل الدفع لكن تعذر تأكيد التفعيل فوراً. سنعيد المزامنة تلقائياً، ويمكنك تحديث الصفحة.',
  subscription_conflict: 'اكتشفنا اشتراكاً آخر مرتبطاً بحسابك. لم نخفِ المشكلة، وسيراجعها فريق التشغيل قبل أي إجراء.',
  checkout_failed: 'تعذر إنشاء جلسة الدفع. لم يتم خصم أي مبلغ.',
  too_many_requests: 'تم طلب بوابة الفوترة عدة مرات خلال فترة قصيرة. انتظر دقيقة ثم أعد المحاولة.',
  security_service_unavailable: 'تعذر التحقق الآمن من طلب الفوترة الآن. أعد المحاولة بعد قليل.',
  internal_access: 'حساب المالك لديه صلاحية داخلية ولا يحتاج اشتراكاً أو تجربة.',
  account_suspended: 'حسابك موقوف مؤقتاً، فما نقدر نبدأ اشتراكاً جديداً الحين. تواصل معنا على واتساب 0554235720.',
  google_ads_account_required: 'اربط حساب إعلانات Google نشطاً أولاً حتى تبدأ التجربة.',
  no_live_subscription: 'ما لقينا اشتراكاً قائماً على هذا الحساب حتى نلغيه.',
  cancel_failed: 'تعذر تنفيذ الطلب الآن ولم يتغيّر اشتراكك. أعد المحاولة بعد قليل، ولو تكرر راسلنا.',
  invalid_origin: 'تعذر التحقق من الطلب. حدّث الصفحة وأعد المحاولة.',
  card_trial_used: CARD_TRIAL_USED_MESSAGE,
  ads_account_trial_used: ADS_ACCOUNT_TRIAL_USED_MESSAGE,
  trial_check_failed: TRIAL_CHECK_FAILED_MESSAGE,
};

const plans = [
  {
    id: 'starter' as PlanKey,
    name: 'البداية',
    nameEn: 'Starter',
    monthlyPrice: 500,
    limit: 'للبداية وإدارة العمل اليومي',
    features: [
      '20 محادثة ذكية يومياً',
      'فحصان أسبوعياً',
      '5 مزامنات يدوية يومياً',
      optimizerAccountsLine(OPTIMIZER_ACCOUNTS_PER_PLAN.starter),
    ],
  },
  {
    id: 'growth' as PlanKey,
    name: 'النمو',
    nameEn: 'Growth',
    monthlyPrice: 1200,
    limit: 'للشركات النشطة والمتابعة اليومية',
    features: [
      '100 محادثة ذكية يومياً',
      '7 فحوصات أسبوعياً',
      '20 تنفيذاً ومزامنة يومياً',
      optimizerAccountsLine(OPTIMIZER_ACCOUNTS_PER_PLAN.growth),
    ],
    highlighted: true,
  },
  {
    id: 'pro' as PlanKey,
    name: 'الاحتراف',
    nameEn: 'Pro',
    monthlyPrice: 2500,
    limit: 'للوكالات والاستخدام المكثف',
    features: [
      '500 محادثة ذكية يومياً',
      '70 فحصاً أسبوعياً',
      '100 تنفيذ ومزامنة يومياً',
      optimizerAccountsLine(OPTIMIZER_ACCOUNTS_PER_PLAN.pro),
    ],
  },
];

const PLAN_IDS: readonly string[] = ['starter', 'growth', 'pro'];

export const metadata = {
  title: 'الاشتراك والفوترة',
};

export default async function BillingPage({
  searchParams,
}: {
  searchParams?: Promise<{ error?: string; canceled?: string; cancel?: string; plan?: string; period?: string }>;
}) {
  const params = await searchParams;
  const period: PeriodKey = params?.period === 'yearly' ? 'yearly' : 'monthly';
  // The landing page carries the visitor's chosen plan through login
  // (`/billing?plan=…`); consume it so they land on a highlighted card, not a
  // bare pricing table that forgot their choice.
  const chosenPlan = params?.plan && PLAN_IDS.includes(params.plan) ? (params.plan as PlanKey) : null;

  const { supabase, user } = await getRequestAuthContext();
  // Every query below is scoped to `user.id` explicitly. RLS already does this,
  // but billing is the wrong place to have exactly one line of defence: a
  // future switch to the admin client, or RLS disabled during an incident,
  // would turn each of these into a cross-tenant read with no second check.
  if (!user) redirect('/login?next=/billing');

  // One shared policy for eligibility and entitlement — this page previously
  // re-implemented both and got both wrong: trial eligibility skipped the
  // durable email ledger (promising a trial checkout would then deny), and
  // "current plan" took the newest row, the exact heuristic entitlements.ts
  // documents as showing a paying customer "no active subscription".
  const [detailedAccess, checkout, hasActiveAccount, invoicesResult, priceAmounts] = await Promise.all([
    getSubscriptionAccessDetailed(supabase, user.id, user.email),
    getBillingCheckoutContext(supabase, user.id, user.email),
    hasActiveGoogleAdsAccount(supabase, user.id),
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
  // With the Arabic checkout on, the plan buttons open /billing/pay instead of the
  // hosted Stripe page. Off (or no browser key), the forms below are used as before.
  const arabicCheckout = isArabicCheckoutAvailable();
  // The eligibility check could not run: say so and offer a retry, never a
  // paid start (the checkout routes refuse it too).
  const checkFailed = checkout.trialIneligibleReason === 'check_failed';
  // Everything Stripe-related renders from the billing truth. A free plan an
  // operator granted (status 'comp' on the effective access) is shown as a note
  // and, only when there is no live Stripe subscription, as the current plan:
  // it must never hide the portal or the cancel controls of a card that Stripe
  // is still going to charge.
  const access = detailedAccess.billing;
  const comp = detailedAccess.access.status === 'comp' ? detailedAccess.access : null;
  const hasInternalAccess = access.status === 'internal';
  const hasLiveSubscription = Boolean(checkout.activeSubscriptionId);
  const compOnly = Boolean(comp && !hasLiveSubscription);
  const currentPlan = hasLiveSubscription || hasInternalAccess ? access.plan : compOnly ? comp!.plan : null;
  const compUntil = comp?.currentPeriodEnd ? formatDateAr(comp.currentPeriodEnd) : null;

  // Our table does not store `cancel_at_period_end`, so read it live from
  // Stripe. If Stripe is unreachable the page still renders, just without the
  // "cancellation scheduled" state.
  let cancelScheduled = false;
  if (hasLiveSubscription && checkout.activeSubscriptionId) {
    try {
      const live = await retrieveStripeSubscription(checkout.activeSubscriptionId);
      cancelScheduled = Boolean(live.cancel_at_period_end || live.cancel_at);
    } catch (error) {
      console.error('Could not read cancellation state from Stripe', error);
    }
  }
  const periodEndIso = access.status === 'trialing' && access.trialEndsAt ? access.trialEndsAt : access.currentPeriodEnd;
  const periodEndLabel = periodEndIso ? formatDateAr(periodEndIso) : null;
  // Mirrors the server gate in /api/billing/checkout: no active Google Ads
  // account means no trial/checkout buttons, just a link to connect one.
  const needsAccount = !hasLiveSubscription && !hasInternalAccess && !hasActiveAccount;
  // Why a trial is not on offer, for the two reasons that need saying; and the
  // Starter-limits line wherever one is.
  const noTrialNotice =
    !hasLiveSubscription && !hasInternalAccess && !compOnly
      ? trialIneligibleNotice(checkout.trialIneligibleReason)
      : null;
  const trialOffered = trialEligible && !hasLiveSubscription && !hasInternalAccess && !compOnly && !needsAccount;

  const buildHref = (nextPeriod: PeriodKey) => {
    const query = new URLSearchParams();
    if (nextPeriod === 'yearly') query.set('period', 'yearly');
    if (chosenPlan) query.set('plan', chosenPlan);
    const qs = query.toString();
    return qs ? `/billing?${qs}` : '/billing';
  };


  // One line for the whole plan list instead of the same sentence under every plan.
  const planNote = hasInternalAccess
    ? 'صلاحية داخلية للاختبار؛ لن تُنشأ فاتورة أو جلسة دفع.'
    : hasLiveSubscription
      ? 'تغيير الخطة يتم داخل بوابة Stripe ويُحتسب الفرق تلقائياً.'
      : checkFailed
        ? 'لم نتأكد من أهليتك للتجربة بعد. البطاقة والفواتير تُدار بأمان عبر Stripe.'
        : trialEligible
          ? 'لن يتم الخصم خلال فترة التجربة. البطاقة والفواتير تُدار بأمان عبر Stripe.'
          : 'تبدأ الفوترة عند التأكيد. البطاقة والفواتير تُدار بأمان عبر Stripe.';

  const periodLink = (value: PeriodKey, label: string) => (
    <Link
      href={buildHref(value)}
      aria-current={period === value ? 'true' : undefined}
      className={cn(
        'inline-flex min-h-9 items-center rounded-full px-4 text-[14px] font-medium transition-colors',
        period === value ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'
      )}
    >
      {label}
    </Link>
  );

  return (
    <CalmPage wide>
      <CalmTitle title="الفوترة والاشتراك" description="إدارة الخطة والتجربة والفواتير." />

      {(params?.error || params?.canceled || params?.cancel === 'resumed' || noTrialNotice) && (
        <div className="mt-6 space-y-3">
          {params?.error && (
            <CalmNote tone="danger">
              {billingErrors[params.error] ?? 'تعذر تنفيذ عملية الفوترة. لم يتم خصم أي مبلغ.'}
            </CalmNote>
          )}
          {params?.canceled && <CalmNote tone="warning">تم إلغاء عملية الدفع ولم يتغيّر اشتراكك.</CalmNote>}
          {params?.cancel === 'resumed' && <CalmNote tone="success">رجع اشتراكك كما كان، ويتجدد في موعده.</CalmNote>}
          {noTrialNotice && <CalmNote tone="info">{noTrialNotice}</CalmNote>}
        </div>
      )}

      {/* Current plan: the page. */}
      <section
        className={cn(CARD, 'mt-6 p-6 sm:flex sm:items-center sm:justify-between sm:gap-10 sm:p-8')}
        aria-labelledby="current-plan-title"
      >
        <div className="min-w-0 sm:max-w-[620px]">
        <p className="text-[13px] text-muted-foreground">الخطة الحالية</p>
        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1">
          <h2 id="current-plan-title" className="text-[26px] font-bold leading-[2.75rem]">
            {currentPlan ? planLabel(currentPlan) : 'لا يوجد اشتراك نشط'}
          </h2>
          {(hasLiveSubscription || hasInternalAccess) && access.status && (
            <StatusWord tone={access.status === 'active' ? 'success' : 'warning'}>
              {subscriptionStatusLabel(access.status)}
            </StatusWord>
          )}
          {compOnly && <StatusWord tone="success">{subscriptionStatusLabel('comp')}</StatusWord>}
        </div>
        <p className="mt-2 text-[15px] leading-8 text-muted-foreground">
          {/* The trial line is gated on the LIVE status: Stripe keeps
              `trial_end` set forever after a trial converts, so keying on
              the timestamp showed "تنتهي التجربة في <تاريخ ماضٍ>" to every
              paying customer instead of their renewal date. */}
          {hasInternalAccess
            ? 'صلاحية المالك مفعلة للاختبار الداخلي ولا ترتبط بفوترة Stripe.'
            : compOnly
            ? `خطة مجانية من فريق مُضاعِف${compUntil ? ` حتى ${compUntil}` : ''}. ما ينخصم منك شيء.`
            : cancelScheduled && periodEndLabel
            ? access.status === 'trialing'
              ? `ألغيت الاشتراك. تنتهي التجربة في ${periodEndLabel} ولن يُخصم منك شيء.`
              : `ألغيت الاشتراك. يبقى شغالاً حتى ${periodEndLabel} ثم يتوقف ولا يتجدد.`
            : access.status === 'trialing' && access.trialEndsAt
            ? `تنتهي التجربة في ${formatDateAr(access.trialEndsAt)}`
            : hasLiveSubscription && access.currentPeriodEnd
              ? `تجديد الاشتراك في ${formatDateAr(access.currentPeriodEnd)}`
              : 'اختر خطة بالأسفل لتفعيل الفحص والتنفيذ والمساعد الذكي.'}
        </p>
        {trialOffered && (
          <p className="mt-1.5 max-w-xl text-[13.5px] leading-7 text-muted-foreground">
            {TRIAL_STARTER_LIMITS_NOTE}
          </p>
        )}
        </div>
        <div className="mt-6 flex-shrink-0 sm:mt-0">
          {hasInternalAccess || compOnly ? (
            <StatusWord tone="success">لا تحتاج اشتراكاً</StatusWord>
          ) : hasLiveSubscription && checkout.stripeCustomerId ? (
            <form action="/api/billing/portal" method="post">
              <PendingSubmitButton pendingLabel="جاري فتح Stripe..." className={pill.primary}>
                البطاقة والفواتير
              </PendingSubmitButton>
            </form>
          ) : needsAccount ? (
            <Link href="/onboarding/connect" className={cn(pill.primary, 'py-2.5 text-center leading-6')}>
              اربط حساب إعلانات Google أولاً عشان تبدأ التجربة
            </Link>
          ) : !hasLiveSubscription && arabicCheckout ? (
            <a href={`${ARABIC_CHECKOUT_PATH}?plan=growth&period=${period}`} className={pill.primary}>
              {checkFailed ? 'حاول من جديد' : trialEligible ? 'ابدأ تجربة خطة النمو' : 'اشترك في خطة النمو'}
            </a>
          ) : !hasLiveSubscription ? (
            <form action="/api/billing/checkout" method="post">
              <input type="hidden" name="plan" value="growth" />
              <input type="hidden" name="period" value={period} />
              <PendingSubmitButton pendingLabel="جاري فتح الدفع..." className={pill.primary}>
                {checkFailed ? 'حاول من جديد' : trialEligible ? 'ابدأ تجربة خطة النمو' : 'اشترك في خطة النمو'}
              </PendingSubmitButton>
            </form>
          ) : null}
        </div>
      </section>

      {comp && hasLiveSubscription && (
        <div className="mt-4">
          <CalmNote tone="success">
            معك خطة {planLabel(comp.plan)} مجانية من فريق مُضاعِف{compUntil ? ` حتى ${compUntil}` : ''}، وهي اللي تشتغل لك الحين.
            اشتراكك في Stripe ما تغيّر ويتجدد في موعده، وتقدر تلغيه من تحت.
          </CalmNote>
        </div>
      )}

      {/* Cancellation. Customers reported "there is no way to cancel": the only
          control was a Stripe-portal button that never said the word. This
          section names the action, confirms it, and shows the scheduled state.
          Plain text on the page, the anchor stays for the link in settings. */}
      {hasLiveSubscription && !hasInternalAccess && (
        <section id="cancel" className="mt-10 scroll-mt-6">
          <CalmHeading title="إلغاء الاشتراك" />
          {cancelScheduled ? (
            <>
              <p className="mt-1 max-w-[640px] text-[14.5px] leading-8 text-muted-foreground">
                {access.status === 'trialing'
                  ? `ألغيت الاشتراك. تنتهي تجربتك في ${periodEndLabel ?? 'نهاية الفترة'} ولن يُخصم منك أي مبلغ.`
                  : `ألغيت الاشتراك. يبقى شغالاً حتى ${periodEndLabel ?? 'نهاية الفترة الحالية'} ثم يتوقف ولا يتجدد.`}{' '}
                إذا غيّرت رأيك قبل هذا التاريخ، تقدر ترجعه بضغطة وحدة.
              </p>
              <form action="/api/billing/cancel" method="post" className="mt-4">
                <input type="hidden" name="action" value="resume" />
                <PendingSubmitButton pendingLabel="جاري التراجع..." className={pill.quiet}>
                  تراجع عن الإلغاء
                </PendingSubmitButton>
              </form>
            </>
          ) : (
            <>
              <p className="mt-1 max-w-[640px] text-[14.5px] leading-8 text-muted-foreground">
                {access.status === 'trialing'
                  ? `أنت في التجربة المجانية وتنتهي في ${periodEndLabel ?? 'نهاية الفترة'}. لو ألغيت قبلها ما ينخصم منك ريال، وتكمل استخدام مُضاعِف حتى آخر يوم في التجربة.`
                  : `الإلغاء ما يوقف الاشتراك فوراً، يبقى شغالاً حتى ${periodEndLabel ?? 'نهاية الفترة الحالية'} ثم يتوقف ولا يتجدد. مبلغ الفترة الحالية لا يُسترد، وتفاصيل ذلك في `}
                {access.status !== 'trialing' && (
                  <>
                    <Link href="/refund" className="font-semibold text-foreground underline underline-offset-4">
                      صفحة الاسترجاع
                    </Link>
                    .
                  </>
                )}{' '}
                حسابك وبياناتك تبقى كما هي، وتقدر تشترك من جديد وقت ما تبي.
              </p>
              <details className="group mt-4">
                <summary
                  className={cn(pill.dangerQuiet, 'cursor-pointer list-none [&::-webkit-details-marker]:hidden')}
                >
                  إلغاء الاشتراك
                </summary>
                <div className="mt-4 max-w-xl rounded-[16px] border border-danger/25 bg-danger-soft/50 p-5">
                  <p className="text-[14.5px] font-semibold leading-7">متأكد أنك تبي تلغي؟</p>
                  <p className="mt-1 text-[13.5px] leading-7 text-muted-foreground">
                    {access.status === 'trialing'
                      ? 'ما راح يتحول اشتراكك إلى مدفوع بعد التجربة.'
                      : 'ما راح يتجدد اشتراكك بعد نهاية الفترة الحالية.'}{' '}
                    تقدر تتراجع من هذي الصفحة قبل الموعد.
                  </p>
                  <form action="/api/billing/cancel" method="post" className="mt-4">
                    <input type="hidden" name="action" value="cancel" />
                    <PendingSubmitButton pendingLabel="جاري الإلغاء..." className={pill.danger}>
                      نعم، ألغِ اشتراكي
                    </PendingSubmitButton>
                  </form>
                </div>
              </details>
            </>
          )}
        </section>
      )}

      {/* Plans: one list, not three twin cards. The billing period toggle stays — the
          six Stripe prices include yearly slots that were configured, enforced by the
          readiness check, and impossible to buy while every form hardcoded
          `period=monthly`. */}
      <section className="mt-10" aria-labelledby="plans-title">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 id="plans-title" className="text-[16px] font-bold leading-8">
            الخطط المتاحة
          </h2>
          <div className="inline-flex items-center rounded-full bg-muted p-1" role="group" aria-label="فترة الفوترة">
            {periodLink('monthly', 'شهري')}
            {periodLink('yearly', 'سنوي')}
          </div>
        </div>

        <ul className="grid gap-4 lg:grid-cols-3">
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
            // One dark card per list: the customer's own pick, else the recommended plan
            // (never on top of the plan they already have).
            const featured = !isCurrent && (chosenPlan ? isChosen : Boolean(plan.highlighted) && !currentPlan);
            const cta = cn(featured ? cn(pill.primary, 'bg-background text-foreground hover:bg-background/90') : pill.quiet, 'w-full');

            return (
              <li
                key={plan.id}
                className={cn(
                  'flex flex-col rounded-[18px] border p-6 sm:p-7',
                  featured ? 'border-foreground bg-foreground text-background' : 'border-border/80 bg-card',
                  isCurrent && 'border-foreground'
                )}
              >
                <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                  <h3 className="text-[20px] font-bold leading-8">{plan.name}</h3>
                  {isCurrent ? (
                    <Tag tone="strong">{hasInternalAccess ? 'مفعلة داخلياً' : 'خطتك الحالية'}</Tag>
                  ) : isChosen ? (
                    <span className="inline-flex items-center rounded-full bg-signal px-2.5 py-0.5 text-[12.5px] font-semibold text-signal-foreground">
                      اختيارك
                    </span>
                  ) : plan.highlighted && !chosenPlan && !currentPlan ? (
                    <span className="inline-flex items-center rounded-full bg-signal px-2.5 py-0.5 text-[12.5px] font-semibold text-signal-foreground">
                      الأنسب
                    </span>
                  ) : null}
                </div>
                <p className={cn('mt-0.5 text-[14px] leading-7', featured ? 'text-background/70' : 'text-muted-foreground')}>
                  {plan.limit}
                </p>

                <div className="mt-5 flex flex-wrap items-baseline gap-x-1.5">
                  {displayAmount !== null ? (
                    <>
                      <span className="numeric text-[34px] font-bold leading-[2.75rem]">
                        {formatCurrency(displayAmount, displayCurrency)}
                      </span>
                      <span className={cn('text-[14px]', featured ? 'text-background/70' : 'text-muted-foreground')}>
                        / {period === 'yearly' ? 'سنة' : 'شهر'}
                      </span>
                    </>
                  ) : (
                    <span className="text-[14px] font-semibold leading-7">
                      فوترة سنوية، ويظهر المبلغ النهائي في صفحة الدفع
                    </span>
                  )}
                </div>
                {yearlySavings > 0 && (
                  <p className={cn('mt-0.5 text-[13px] font-medium', featured ? 'text-signal' : 'text-success')}>
                    وفّر {formatCurrency(yearlySavings, 'SAR')} مقارنة بالدفع الشهري
                  </p>
                )}

                <div className="mt-5">
                  {hasInternalAccess ? (
                    <div aria-disabled="true" className={cn(isCurrent ? pill.primary : pill.quiet, 'w-full')}>
                      {isCurrent ? 'مفعلة بصلاحية المالك' : 'متاحة للعملاء'}
                    </div>
                  ) : isCurrent && compOnly ? (
                    // A free plan from the team has no Stripe customer, so no portal to open.
                    <div aria-disabled="true" className={cn(pill.primary, 'w-full')}>
                      مفعلة من فريق مُضاعِف
                    </div>
                  ) : isCurrent ? (
                    <form action="/api/billing/portal" method="post">
                      <PendingSubmitButton pendingLabel="جاري فتح Stripe..." className={cn(pill.quiet, 'w-full')}>
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
                      <PendingSubmitButton pendingLabel="جاري فتح Stripe..." className={cta}>
                        التبديل عبر بوابة Stripe
                      </PendingSubmitButton>
                    </form>
                  ) : needsAccount ? null : arabicCheckout ? (
                    <a href={`${ARABIC_CHECKOUT_PATH}?plan=${plan.id}&period=${period}`} className={cta}>
                      {checkFailed ? 'حاول من جديد' : trialEligible ? 'ابدأ تجربة 14 يوم' : 'اشترك الآن'}
                    </a>
                  ) : (
                    <form action="/api/billing/checkout" method="post">
                      <input type="hidden" name="plan" value={plan.id} />
                      <input type="hidden" name="period" value={period} />
                      <PendingSubmitButton pendingLabel="جاري فتح الدفع..." className={cta}>
                        {checkFailed ? 'حاول من جديد' : trialEligible ? 'ابدأ تجربة 14 يوم' : 'اشترك الآن'}
                      </PendingSubmitButton>
                    </form>
                  )}
                </div>

                <ul
                  className={cn(
                    'mt-6 space-y-1 border-t pt-5 text-[14px]',
                    featured ? 'border-background/20' : 'border-border/70'
                  )}
                >
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex items-start gap-2.5 leading-7">
                      <Check
                        className={cn('mt-1.5 h-4 w-4 flex-shrink-0', featured ? 'text-signal' : 'text-muted-foreground')}
                        aria-hidden
                      />
                      {feature}
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ul>

        <p className="mt-3 text-[13px] leading-7 text-muted-foreground">
          {needsAccount && (
            <>
              <Link href="/onboarding/connect" className="font-semibold text-foreground underline underline-offset-4">
                اربط حساب إعلانات Google أولاً عشان تبدأ التجربة
              </Link>
              {'. '}
            </>
          )}
          {planNote}
        </p>
      </section>

      {/* Invoices */}
      <section className="mt-10" aria-labelledby="invoices-title">
        <CalmHeading
          id="invoices-title"
          title="آخر الفواتير"
          hint={invoices.length > 0 ? 'آخر 5 فواتير صادرة على هذا الحساب.' : undefined}
          className="mb-3"
        />
        {invoices.length === 0 ? (
          <div className="py-6">
            <p className="text-[15.5px] font-semibold leading-8">لا توجد فواتير بعد</p>
            <p className="max-w-[560px] text-[14.5px] leading-8 text-muted-foreground">
              أول فاتورة تظهر هنا بعد انتهاء التجربة وبدء أول دورة فوترة. الفواتير تُصدَر وتُحفظ عبر Stripe.
            </p>
          </div>
        ) : (
          <ul className={cn(CARD, 'divide-y divide-border/70 overflow-hidden')}>
            {invoices.map((invoice: any) => (
              <li
                key={`${invoice.invoice_number}-${invoice.created_at}`}
                className="flex items-center justify-between gap-4 px-5 py-4 sm:px-7"
              >
                <div className="min-w-0">
                  <div className="text-[15px] font-semibold text-foreground">{invoice.invoice_number ?? 'فاتورة'}</div>
                  <div className="text-[13px] text-muted-foreground">{subscriptionStatusLabel(invoice.status)}</div>
                </div>
                <div className="flex flex-shrink-0 items-center gap-3">
                  <span className="numeric text-[15px] font-bold">
                    {formatCurrency(invoice.amount_sar ?? 0, invoice.currency ?? 'SAR')}
                  </span>
                  {invoice.invoice_url && (
                    <a
                      href={invoice.invoice_url}
                      className="inline-flex min-h-9 items-center rounded-full border border-border px-4 text-[13.5px] font-semibold hover:bg-muted"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      عرض
                    </a>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </CalmPage>
  );
}
