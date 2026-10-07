import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowLeft, CreditCard } from 'lucide-react';
import { getAccountWorkspace } from '@/lib/accounts/selection';
import { googleAdsAccountDisplayName } from '@/lib/accounts/display';
import { getRequestAuthContext } from '@/lib/supabase/server';
import { getSubscriptionAccess } from '@/lib/billing/entitlements';
import {
  getBillingCheckoutContext,
  ONBOARDING_CHECKOUT_RETURN,
  TRIAL_DAYS,
} from '@/lib/billing/checkout-policy';
import { getPlanPriceAmounts } from '@/lib/billing/stripe';
import { Alert } from '@/lib/ui/alert';
import { buttonClasses } from '@/lib/ui/button';
import { PendingSubmitButton } from '@/lib/ui/pending-submit-button';
import { formatCurrency, formatDateAr } from '@/lib/utils';
import { daysLabel, firstChargeDate } from '@/lib/onboarding/trial';
import { OnboardingProgress } from '../onboarding-progress';

export const metadata = {
  title: 'ابدأ تجربتك',
};

/** The plan the trial checkout starts on; the same one /billing offers. */
const TRIAL_PLAN = 'growth' as const;

const errors: Record<string, string> = {
  checkout_failed: 'ما قدرنا نفتح صفحة الدفع. لم يُخصم أي مبلغ، جرّب مرة ثانية.',
  invalid_plan: 'الخطة غير صالحة. حدّث الصفحة وجرّب مرة ثانية.',
  google_ads_account_required: 'اربط حساب Google Ads نشطاً أولاً.',
  already_subscribed: 'عندك اشتراك قائم، تقدر تكمل مباشرة.',
};

export default async function TrialPage({
  searchParams,
}: {
  searchParams?: Promise<{ error?: string; canceled?: string }>;
}) {
  const params = await searchParams;
  const { supabase, user } = await getRequestAuthContext();
  if (!user) redirect('/login?next=/onboarding/trial');

  const { accounts, business, selectedAccount } = await getAccountWorkspace(user.id);
  if (!business) redirect('/onboarding/business');
  if (accounts.length === 0) redirect('/onboarding/connect');
  // With several accounts the user picks one first; nothing is chosen for them.
  if (accounts.length > 1 && !business.selected_google_ads_customer_id) redirect('/onboarding/choose');

  const access = await getSubscriptionAccess(supabase, user.id, user.email);
  if (access.active) redirect('/onboarding/first-audit');

  const [checkout, prices] = await Promise.all([
    getBillingCheckoutContext(supabase, user.id, user.email),
    getPlanPriceAmounts(),
  ]);
  const trialEligible = checkout.trialEligible;
  const price = prices?.[TRIAL_PLAN]?.monthly ?? null;
  const priceText = price ? formatCurrency(price.amount, price.currency.toUpperCase()) : null;
  const chargeDate = formatDateAr(firstChargeDate(TRIAL_DAYS));

  return (
    <main className="px-4 py-8 sm:px-6">
      <div className="mx-auto max-w-4xl">
        <OnboardingProgress active="trial" />

        <div className="mb-6 mt-8">
          <h2 className="text-[26px] font-bold leading-tight sm:text-3xl">
            {trialEligible ? `ابدأ تجربتك ${daysLabel(TRIAL_DAYS)}` : 'فعّل اشتراكك'}
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-7 text-muted-foreground">
            الفحص والتوصيات تشتغل داخل التجربة. بعدها نفحص{' '}
            <span className="font-semibold text-foreground">{googleAdsAccountDisplayName(selectedAccount)}</span>{' '}
            ونطلع لك أول الفرص فيه.
          </p>
        </div>

        {params?.error && (
          <div className="mb-5">
            <Alert tone="danger">{errors[params.error] ?? 'ما قدرنا نكمل. لم يُخصم أي مبلغ.'}</Alert>
          </div>
        )}
        {params?.canceled && (
          <div className="mb-5">
            <Alert tone="info">رجعت قبل إكمال الدفع، وما انخصم شي. تقدر تبدأ من جديد متى ما بغيت.</Alert>
          </div>
        )}

        <section className="surface-card p-5 sm:p-6">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center border border-border text-foreground">
              <CreditCard className="h-4 w-4" />
            </span>
            <div className="min-w-0 space-y-2 text-[13.5px] leading-7 text-foreground">
              {trialEligible ? (
                <>
                  <p>
                    نطلب البطاقة عشان يكمل اشتراكك بعد التجربة بدون انقطاع، وما نخصم شي اليوم.
                  </p>
                  <p>
                    أول خصم يوم <span className="font-semibold">{chargeDate}</span>
                    {priceText ? (
                      <>
                        {' '}
                        بقيمة <span className="numeric font-semibold">{priceText}</span> لخطة النمو الشهرية
                      </>
                    ) : (
                      ' بسعر خطة النمو الشهرية'
                    )}
                    . تقدر تلغي قبله من صفحة الفوترة.
                  </p>
                </>
              ) : (
                <p>
                  استخدمت التجربة المجانية قبل. الاشتراك في خطة النمو الشهرية يبدأ اليوم
                  {priceText ? (
                    <>
                      {' '}
                      بقيمة <span className="numeric font-semibold">{priceText}</span>
                    </>
                  ) : null}
                  .
                </p>
              )}
            </div>
          </div>

          <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5">
            <Link href="/onboarding/first-audit" className={buttonClasses({ variant: 'ghost' })}>
              تخطي الآن
            </Link>
            <form action="/api/billing/start-trial" method="post">
              <input type="hidden" name="plan" value={TRIAL_PLAN} />
              <input type="hidden" name="period" value="monthly" />
              <input type="hidden" name="return_to" value={ONBOARDING_CHECKOUT_RETURN} />
              <PendingSubmitButton
                pendingLabel="جاري فتح الدفع..."
                className={buttonClasses({ variant: 'primary', size: 'lg' })}
              >
                {trialEligible ? 'ابدأ التجربة' : 'اشترك الآن'}
                <ArrowLeft className="h-4 w-4" />
              </PendingSubmitButton>
            </form>
          </div>
        </section>
      </div>
    </main>
  );
}
