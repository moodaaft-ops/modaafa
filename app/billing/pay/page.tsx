import { redirect } from 'next/navigation';
import { getRequestAuthContext } from '@/lib/supabase/server';
import { hasActiveGoogleAdsAccount } from '@/lib/accounts/selection';
import { isModaafaOperator } from '@/lib/platform/operators';
import { readAccessOverrides } from '@/lib/billing/access-overrides';
import {
  checkoutTrialDecision,
  getBillingCheckoutContext,
  ONBOARDING_CHECKOUT_RETURN,
} from '@/lib/billing/checkout-policy';
import { getPlanPriceAmounts } from '@/lib/billing/stripe';
import { isArabicCheckoutAvailable, stripePublishableKey } from '@/lib/billing/arabic-checkout/flag';
import { daysLabel, firstChargeDate } from '@/lib/onboarding/trial';
import { planLabel } from '@/lib/ui/labels';
import { formatCurrency, formatDateAr } from '@/lib/utils';
import { PayClient } from './pay-client';

export const dynamic = 'force-dynamic';

const PLANS = ['starter', 'growth', 'pro'] as const;
const PERIODS = ['monthly', 'yearly'] as const;

/**
 * /billing/pay?plan=growth&period=monthly[&return_to=onboarding]
 *
 * The server decides everything that has to be true before a card is asked for
 * (signed in, not already subscribed, a Google Ads account linked, whether a trial
 * is on offer). The API routes decide it again on every call; this page only
 * avoids showing a card field to someone who would be refused.
 */
export default async function PayPage({
  searchParams,
}: {
  searchParams?: Promise<{ plan?: string; period?: string; return_to?: string }>;
}) {
  const params = await searchParams;
  const fromOnboarding = params?.return_to === ONBOARDING_CHECKOUT_RETURN;
  const backPath = fromOnboarding ? '/onboarding/trial' : '/billing';

  // Flag off, or the browser key missing: the old pages never link here, and a
  // typed address goes back to them.
  const publishableKey = stripePublishableKey();
  if (!isArabicCheckoutAvailable() || !publishableKey) redirect(backPath);

  const plan = PLANS.find((value) => value === params?.plan);
  const period = PERIODS.find((value) => value === params?.period);
  if (!plan || !period) redirect(`${backPath}?error=invalid_plan`);

  const { supabase, user } = await getRequestAuthContext();
  if (!user?.email) redirect('/login?next=/billing');
  if (isModaafaOperator(user.email)) redirect(`${backPath}?error=internal_access`);
  if ((await readAccessOverrides(supabase, user.id)).suspended) redirect(`${backPath}?error=account_suspended`);

  const [billing, prices] = await Promise.all([
    getBillingCheckoutContext(supabase, user.id, user.email),
    getPlanPriceAmounts(),
  ]);
  if (billing.activeSubscriptionId) redirect('/billing');
  if (!(await hasActiveGoogleAdsAccount(supabase, user.id))) {
    redirect(`${backPath}?error=google_ads_account_required`);
  }
  const decision = checkoutTrialDecision(billing);
  if (decision.action === 'blocked') redirect(`${backPath}?error=${decision.error}`);

  // No configured price means no honest number to show: the hosted page can still sell it.
  const price = prices?.[plan]?.[period] ?? null;
  if (!price) redirect(backPath);

  const trialDays = decision.trialDays;
  const chargeDate = formatDateAr(firstChargeDate(trialDays));

  return (
    <main className="px-4 py-8 sm:px-6 sm:py-12">
      <PayClient
        publishableKey={publishableKey}
        plan={plan}
        period={period}
        planName={`خطة ${planLabel(plan)}`}
        periodWord={period === 'monthly' ? 'شهرياً' : 'سنوياً'}
        amount={price.amount}
        currency={price.currency}
        amountText={formatCurrency(price.amount, price.currency.toUpperCase())}
        trialDays={trialDays}
        trialLabel={daysLabel(trialDays)}
        chargeDateText={chargeDate}
        returnTo={fromOnboarding ? ONBOARDING_CHECKOUT_RETURN : null}
        backPath={backPath}
        fallbackAction={trialDays > 0 ? '/api/billing/start-trial' : '/api/billing/checkout'}
      />
    </main>
  );
}
