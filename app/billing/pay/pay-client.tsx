'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Elements,
  ExpressCheckoutElement,
  PaymentElement,
  useElements,
  useStripe,
} from '@stripe/react-stripe-js';
import {
  loadStripe,
  type SetupIntent,
  type Stripe,
  type StripeExpressCheckoutElementConfirmEvent,
  type StripeExpressCheckoutElementOptions,
} from '@stripe/stripe-js';
import { ArrowLeft, Check, Loader2, Lock, X } from 'lucide-react';
import { Alert } from '@/lib/ui/alert';
import { buttonClasses } from '@/lib/ui/button';
import { cn } from '@/lib/utils';
import {
  arabicCheckoutError,
  isNetworkFailure,
  type CheckoutErrorAction,
} from '@/lib/billing/arabic-checkout/errors';

type Props = {
  publishableKey: string;
  plan: string;
  period: string;
  planName: string;
  periodWord: string;
  amount: number;
  currency: string;
  amountText: string;
  trialDays: number;
  trialLabel: string;
  chargeDateText: string;
  /** The first charge date as an ISO string, for the Apple Pay sheet. */
  chargeDateIso: string;
  returnTo: string | null;
  backPath: string;
  fallbackAction: string;
};

type Intent = { clientSecret: string; setupIntentId: string };
type Promo = { code: string; label: string; firstCharge: number | null };
type Failure = { code: string; message: string; action: CheckoutErrorAction; back?: string };
type Phase = 'loading' | 'ready' | 'success' | 'failed' | 'fallback';
type Busy = null | 'card' | 'activate' | 'bank' | 'promo';

type ApiResult = { ok: boolean; status: number; json: Record<string, any> };

/** Errors that mean "our side or the network broke", where the hosted Stripe page can still take the payment. */
const FALLBACK_CODES = new Set(['checkout_failed', 'api_connection_error', 'network_error']);

/** The platform's own Arabic face, loaded inside Stripe's card frame so the field matches the page. */
const STRIPE_FONTS = [
  { cssSrc: 'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600&display=swap' },
];

const stripeLoaders = new Map<string, Promise<Stripe | null>>();
function stripeFor(key: string) {
  let loader = stripeLoaders.get(key);
  if (!loader) {
    loader = loadStripe(key, { locale: 'ar' });
    stripeLoaders.set(key, loader);
  }
  return loader;
}

async function post(path: string, body: Record<string, unknown>): Promise<ApiResult> {
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    let json: Record<string, any> = {};
    try {
      json = await response.json();
    } catch {
      // A body that is not JSON is read as a generic failure below.
    }
    return { ok: response.ok, status: response.status, json };
  } catch (error) {
    // Once the subscription may exist (the last two steps), a lost answer does not
    // mean "nothing was charged", and the hosted page must not be offered as a retry.
    const mayHaveCharged = path.endsWith('/subscribe') || path.endsWith('/finalize');
    const view = arabicCheckoutError(
      mayHaveCharged ? 'payment_status_unknown' : isNetworkFailure(error) ? 'network_error' : 'checkout_failed',
    );
    return { ok: false, status: 0, json: { error: view.code, message: view.message, action: view.action } };
  }
}

function failureFrom(result: ApiResult): Failure {
  const view = arabicCheckoutError(result.json.error);
  return {
    code: String(result.json.error ?? view.code),
    message: typeof result.json.message === 'string' && result.json.message ? result.json.message : view.message,
    action: (result.json.action as CheckoutErrorAction) ?? view.action,
    back: typeof result.json.back === 'string' ? result.json.back : undefined,
  };
}

/**
 * The number and the currency word kept apart. Written as one string, the
 * bidirectional algorithm flips "1,200 ر.س" around inside an Arabic sentence.
 */
function splitMoney(value: number, currency: string) {
  const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value);
  const unit = currency.toLowerCase() === 'sar' ? 'ر.س' : currency.toUpperCase();
  return { number, unit };
}

function Money(props: {
  value: number;
  currency: string;
  className?: string;
  numberClassName?: string;
  unitClassName?: string;
}) {
  const { number, unit } = splitMoney(props.value, props.currency);
  return (
    <span className={cn('inline-flex items-baseline gap-1.5 whitespace-nowrap', props.className)}>
      <bdi className={cn('font-numeric', props.numberClassName)} dir="ltr">
        {number}
      </bdi>
      <span className={props.unitClassName}>{unit}</span>
    </span>
  );
}

export function PayClient(props: Props) {
  const { publishableKey, plan, period, trialDays, returnTo, backPath } = props;
  const [phase, setPhase] = useState<Phase>('loading');
  const [intent, setIntent] = useState<Intent | null>(null);
  const [stripe, setStripe] = useState<Stripe | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [promo, setPromo] = useState<Promo | null>(null);
  const [redirectTo, setRedirectTo] = useState<string | null>(null);
  const started = useRef(false);

  const prepare = useCallback(async () => {
    setPhase('loading');
    setFailure(null);
    setIntent(null);
    const [loaded, result] = await Promise.all([
      stripeFor(publishableKey).catch(() => null),
      post('/api/billing/arabic/intent', { plan, period }),
    ]);
    if (!loaded) {
      // Stripe.js did not load (blocked, offline): the hosted page is the way through.
      const view = arabicCheckoutError('checkout_failed');
      setFailure({ code: view.code, message: view.message, action: view.action });
      setPhase('fallback');
      return;
    }
    if (!result.ok || typeof result.json.client_secret !== 'string') {
      const next = failureFrom(result);
      setFailure(next);
      setPhase(FALLBACK_CODES.has(next.code) ? 'fallback' : 'failed');
      return;
    }
    setStripe(loaded);
    setIntent({ clientSecret: result.json.client_secret, setupIntentId: String(result.json.setup_intent_id) });
    setPhase('ready');
  }, [period, plan, publishableKey]);

  useEffect(() => {
    // React runs effects twice in development; one intent is enough.
    if (started.current) return;
    started.current = true;
    void prepare();
  }, [prepare]);

  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (phase === 'success' || phase === 'failed') headingRef.current?.focus();
  }, [phase]);

  useEffect(() => {
    if (phase !== 'success' || !redirectTo) return;
    const timer = window.setTimeout(() => window.location.assign(redirectTo), 3000);
    return () => window.clearTimeout(timer);
  }, [phase, redirectTo]);

  const hasTrial = trialDays > 0;
  const chargeAmount = promo?.firstCharge ?? props.amount;

  if (phase === 'success') {
    return (
      <SuccessView
        headingRef={headingRef}
        hasTrial={hasTrial}
        chargeDateText={props.chargeDateText}
        redirectTo={redirectTo ?? '/dashboard?subscribed=1'}
      />
    );
  }
  if (phase === 'failed' && failure) {
    return (
      <FailureView
        headingRef={headingRef}
        failure={failure}
        backPath={failure.back ?? backPath}
        onRetry={() => void prepare()}
      />
    );
  }

  return (
    <div className="mx-auto grid max-w-5xl gap-10 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start lg:gap-16">
      <section aria-labelledby="pay-title" className="min-w-0 max-w-[34rem]">
        <p className="text-[13px] font-medium text-muted-foreground">
          {props.planName}، {props.periodWord}
        </p>
        <h1
          id="pay-title"
          className="mt-2 font-display text-[1.75rem] font-semibold leading-[1.3] text-balance sm:text-[2.25rem]"
        >
          {hasTrial ? 'ابدأ تجربتك المجانية' : `اشترك في ${props.planName}`}
        </h1>
        <p className="mt-3 text-[15px] leading-8 text-muted-foreground">
          {hasTrial
            ? `${props.trialLabel} كاملة بدون أي خصم. أول دفعة يوم ${props.chargeDateText}، وتقدر تلغي قبلها بضغطة.`
            : `ينخصم المبلغ اليوم ويتجدد ${props.periodWord} من نفس الوسيلة، وتلغي متى ما بغيت.`}
        </p>

        <ScheduleStrip
          className="mt-6 lg:hidden"
          hasTrial={hasTrial}
          amount={chargeAmount}
          currency={props.currency}
          chargeDateText={props.chargeDateText}
          promoLabel={promo?.label ?? null}
        />

        <div className="mt-8">
          {phase === 'loading' && <LoadingBlock />}

          {phase === 'fallback' && failure && (
            <FallbackBlock
              message={failure.message}
              action={props.fallbackAction}
              plan={plan}
              period={period}
              returnTo={returnTo}
              onRetry={() => void prepare()}
            />
          )}

          {phase === 'ready' && intent && stripe && (
            <Elements
              key={intent.setupIntentId}
              stripe={stripe}
              options={{ clientSecret: intent.clientSecret, locale: 'ar', appearance: appearance(), fonts: STRIPE_FONTS }}
            >
              <PaymentArea
                intent={intent}
                hasTrial={hasTrial}
                amount={chargeAmount}
                regularAmount={props.amount}
                currency={props.currency}
                period={period}
                plan={plan}
                planName={props.planName}
                chargeDateIso={props.chargeDateIso}
                returnTo={returnTo}
                promo={promo}
                onPromo={setPromo}
                onSuccess={(destination) => {
                  setRedirectTo(destination);
                  setPhase('success');
                }}
                onFailure={(next) => {
                  setFailure(next);
                  setPhase('failed');
                }}
              />
            </Elements>
          )}
        </div>

        <div className="mt-8 flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-t border-border pt-5">
          <p className="flex items-center gap-2 text-[13px] leading-6 text-muted-foreground">
            <Lock aria-hidden className="h-3.5 w-3.5 flex-shrink-0" />
            <span>الدفع عن طريق Stripe، وبيانات البطاقة ما تمر على خوادم مُضاعِف</span>
          </p>
          <Link
            href={backPath}
            className="text-[13px] font-semibold text-foreground underline decoration-border-strong underline-offset-4 hover:decoration-foreground"
          >
            رجوع بدون دفع
          </Link>
        </div>
      </section>

      <aside aria-label="جدول الدفع" className="hidden lg:sticky lg:top-8 lg:block">
        <ScheduleCard
          hasTrial={hasTrial}
          amount={chargeAmount}
          regularAmount={props.amount}
          currency={props.currency}
          periodWord={props.periodWord}
          chargeDateText={props.chargeDateText}
          trialLabel={props.trialLabel}
          promoLabel={promo?.label ?? null}
        />
      </aside>
    </div>
  );
}

/**
 * The one strong element on the page: what leaves the customer's account and
 * when. Inverted (ink on the light theme, paper on the dark one) so it reads as
 * a receipt sitting beside the form.
 */
function ScheduleCard(props: {
  hasTrial: boolean;
  amount: number;
  regularAmount: number;
  currency: string;
  periodWord: string;
  chargeDateText: string;
  trialLabel: string;
  promoLabel: string | null;
}) {
  const today = props.hasTrial ? 0 : props.amount;
  return (
    <div className="bg-foreground p-7 text-background">
      <p className="text-[13px] font-medium opacity-70">المبلغ اليوم</p>
      <Money
        value={today}
        currency={props.currency}
        className="mt-3 gap-3"
        numberClassName="text-[4.5rem] font-semibold leading-none tracking-tight"
        unitClassName="text-xl font-semibold opacity-80"
      />

      <ol className="mt-8 border-t border-background/20">
        <li className="flex items-start gap-3 border-b border-background/20 py-4">
          <span aria-hidden className="mt-1.5 h-2.5 w-2.5 flex-shrink-0 bg-signal" />
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-semibold">اليوم</p>
            <p className="mt-0.5 text-[13px] leading-6 opacity-70">
              {props.hasTrial ? `تبدأ التجربة، ${props.trialLabel}` : 'يبدأ الاشتراك'}
            </p>
          </div>
          <Money value={today} currency={props.currency} className="text-[14px] font-semibold" />
        </li>
        {props.hasTrial && (
          <li className="flex items-start gap-3 border-b border-background/20 py-4">
            <span aria-hidden className="mt-1.5 h-2.5 w-2.5 flex-shrink-0 border border-background/60" />
            <div className="min-w-0 flex-1">
              <p className="text-[14px] font-semibold">{props.chargeDateText}</p>
              <p className="mt-0.5 text-[13px] leading-6 opacity-70">أول دفعة، إلا لو ألغيت قبلها</p>
            </div>
            <Money value={props.amount} currency={props.currency} className="text-[14px] font-semibold" />
          </li>
        )}
        <li className="flex items-start gap-3 py-4">
          <span aria-hidden className="mt-1.5 h-2.5 w-2.5 flex-shrink-0 border border-background/30" />
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-semibold">بعدها</p>
            <p className="mt-0.5 text-[13px] leading-6 opacity-70">يتجدد {props.periodWord}</p>
          </div>
          <Money value={props.regularAmount} currency={props.currency} className="text-[14px] font-semibold" />
        </li>
      </ol>

      {props.promoLabel && (
        <p className="mt-4 flex items-center gap-2 text-[13px] leading-6">
          <Check aria-hidden className="h-4 w-4 flex-shrink-0 text-signal" />
          {props.promoLabel}
        </p>
      )}
      <p className="mt-5 text-[13px] leading-7 opacity-70">
        الإلغاء من صفحة الفوترة في أي وقت.
        {props.hasTrial ? ' لو ألغيت قبل أول دفعة، ما ينخصم منك شي.' : ''}
      </p>
    </div>
  );
}

/** The same schedule, folded into two lines for the phone, above the buttons. */
function ScheduleStrip(props: {
  className?: string;
  hasTrial: boolean;
  amount: number;
  currency: string;
  chargeDateText: string;
  promoLabel: string | null;
}) {
  return (
    <div className={cn('border border-border bg-card', props.className)}>
      <dl className="grid grid-cols-2 divide-x divide-x-reverse divide-border">
        <div className="px-4 py-3">
          <dt className="flex items-center gap-2 text-[12px] font-medium text-muted-foreground">
            <span aria-hidden className="h-2 w-2 bg-signal" />
            اليوم
          </dt>
          <dd className="mt-1 text-lg font-semibold">
            <Money value={props.hasTrial ? 0 : props.amount} currency={props.currency} unitClassName="text-sm" />
          </dd>
        </div>
        <div className="px-4 py-3">
          <dt className="text-[12px] font-medium text-muted-foreground">
            {props.hasTrial ? props.chargeDateText : 'التجديد'}
          </dt>
          <dd className="mt-1 text-lg font-semibold">
            <Money value={props.amount} currency={props.currency} unitClassName="text-sm" />
          </dd>
        </div>
      </dl>
      {props.promoLabel && (
        <p className="border-t border-border px-4 py-2.5 text-[12.5px] leading-6">{props.promoLabel}</p>
      )}
    </div>
  );
}

function LoadingBlock() {
  return (
    <div className="space-y-3" role="status" aria-live="polite">
      <div className="h-12 animate-pulse bg-muted" />
      <div className="h-px bg-border" />
      <div className="h-12 animate-pulse bg-muted" />
      <div className="grid grid-cols-2 gap-3">
        <div className="h-12 animate-pulse bg-muted" />
        <div className="h-12 animate-pulse bg-muted" />
      </div>
      <span className="sr-only">جاري تجهيز الدفع</span>
    </div>
  );
}

function appearance() {
  const dark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
  return {
    theme: dark ? ('night' as const) : ('flat' as const),
    variables: {
      colorPrimary: dark ? '#F4F2EC' : '#0E1426',
      colorBackground: dark ? '#121A30' : '#FFFFFF',
      colorText: dark ? '#F4F2EC' : '#0E1426',
      colorTextSecondary: dark ? '#A9B0BF' : '#586174',
      colorTextPlaceholder: dark ? '#7C8597' : '#8A91A0',
      colorDanger: dark ? '#FF8A80' : '#B3261E',
      borderRadius: '0px',
      fontFamily: '"IBM Plex Sans Arabic", system-ui, -apple-system, "Segoe UI", sans-serif',
      fontSizeBase: '15px',
      spacingUnit: '4px',
    },
    rules: {
      '.Input': { border: `1px solid ${dark ? '#2A3350' : '#D9D5CA'}`, boxShadow: 'none', padding: '13px 14px' },
      '.Input:focus': { border: `1px solid ${dark ? '#F4F2EC' : '#0E1426'}`, boxShadow: 'none' },
      '.Label': { fontWeight: '500', fontSize: '13px', marginBottom: '6px' },
    },
  };
}

function PaymentArea(props: {
  intent: Intent;
  hasTrial: boolean;
  amount: number;
  regularAmount: number;
  currency: string;
  period: string;
  plan: string;
  planName: string;
  chargeDateIso: string;
  returnTo: string | null;
  promo: Promo | null;
  onPromo: (promo: Promo | null) => void;
  onSuccess: (destination: string) => void;
  onFailure: (failure: Failure) => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const { intent, hasTrial, plan, period, returnTo, promo, onPromo, onSuccess, onFailure } = props;
  const [busy, setBusy] = useState<Busy>(null);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [wallets, setWallets] = useState(false);
  // A ref, not state: two clicks in the same frame both see the same stale state,
  // and the wallet button and the card button share it.
  const lock = useRef(false);

  const finishWith = (result: ApiResult) => {
    if (result.ok && result.json.status === 'ok') {
      const destination = String(result.json.redirect ?? '');
      onSuccess(destination.startsWith('/') && !destination.startsWith('//') ? destination : '/dashboard?subscribed=1');
      return true;
    }
    return false;
  };

  /** After the card (or the wallet's card) is saved: the same server steps for both. */
  const activate = async (setupIntent: SetupIntent | undefined) => {
    if (setupIntent?.status !== 'succeeded') {
      setInlineError(arabicCheckoutError('setup_not_completed').message);
      return;
    }
    setBusy('activate');
    const subscribed = await post('/api/billing/arabic/subscribe', {
      setup_intent_id: intent.setupIntentId,
      promo_code: promo?.code ?? '',
      return_to: returnTo ?? undefined,
    });
    if (finishWith(subscribed)) return;

    if (subscribed.ok && subscribed.json.status === 'requires_action' && stripe) {
      // The bank wants its own check on the first charge (3D Secure).
      setBusy('bank');
      const action = await stripe.handleNextAction({ clientSecret: String(subscribed.json.client_secret) });
      setBusy('activate');
      // Whatever the bank said, the server reads the real outcome from Stripe.
      const finalized = await post('/api/billing/arabic/finalize', {
        subscription_id: subscribed.json.subscription_id,
        return_to: returnTo ?? undefined,
      });
      if (finishWith(finalized)) return;
      if (action.error && !finalized.json.error) {
        const view = arabicCheckoutError({ code: action.error.code, decline_code: action.error.decline_code });
        onFailure({ code: view.code, message: view.message, action: view.action });
        return;
      }
      onFailure(failureFrom(finalized));
      return;
    }
    onFailure(failureFrom(subscribed));
  };

  const submitCard = async (event: React.FormEvent) => {
    event.preventDefault();
    if (lock.current || !stripe || !elements) return;
    lock.current = true;
    setInlineError(null);
    setBusy('card');
    try {
      const checked = await elements.submit();
      if (checked.error) {
        setInlineError(arabicCheckoutError({ code: checked.error.code, decline_code: checked.error.decline_code, type: checked.error.type }).message);
        return;
      }
      const saved = await stripe.confirmSetup({ elements, redirect: 'if_required' });
      if (saved.error) {
        // The card was refused or the check failed before anything was created: stay on the form.
        setInlineError(
          arabicCheckoutError({ code: saved.error.code, decline_code: saved.error.decline_code, type: saved.error.type }).message,
        );
        return;
      }
      await activate(saved.setupIntent);
    } catch (error) {
      const view = arabicCheckoutError(isNetworkFailure(error) ? 'network_error' : 'checkout_failed');
      setInlineError(view.message);
    } finally {
      lock.current = false;
      setBusy(null);
    }
  };

  /** Apple Pay or Google Pay: the wallet sheet already holds the card, so one tap saves it. */
  const confirmWallet = async (event: StripeExpressCheckoutElementConfirmEvent) => {
    if (lock.current || !stripe || !elements) {
      event.paymentFailed({ reason: 'fail' });
      return;
    }
    lock.current = true;
    setInlineError(null);
    setBusy('card');
    try {
      const saved = await stripe.confirmSetup({ elements, redirect: 'if_required' });
      if (saved.error) {
        event.paymentFailed({ reason: 'fail' });
        setInlineError(
          arabicCheckoutError({ code: saved.error.code, decline_code: saved.error.decline_code, type: saved.error.type }).message,
        );
        return;
      }
      await activate(saved.setupIntent);
    } catch (error) {
      event.paymentFailed({ reason: 'fail' });
      const view = arabicCheckoutError(isNetworkFailure(error) ? 'network_error' : 'checkout_failed');
      setInlineError(view.message);
    } finally {
      lock.current = false;
      setBusy(null);
    }
  };

  const working = busy === 'card' || busy === 'activate' || busy === 'bank';
  const amountText = (() => {
    const { number, unit } = splitMoney(props.amount, props.currency);
    return `${number} ${unit}`;
  })();
  const label = hasTrial ? 'ابدأ التجربة المجانية' : `ادفع ${amountText}`;
  const workingLabel =
    busy === 'bank' ? 'بانتظار تأكيد البنك...' : busy === 'activate' ? 'جاري تفعيل اشتراكك...' : 'جاري التحقق من البطاقة...';

  return (
    <div>
      <div hidden={!wallets} aria-hidden={!wallets}>
        <ExpressCheckoutElement
          options={expressOptions(props)}
          onReady={(event) => setWallets(Boolean(event.availablePaymentMethods))}
          onConfirm={(event) => void confirmWallet(event)}
        />
        <div className="my-6 flex items-center gap-4 text-[13px] text-muted-foreground" aria-hidden>
          <span className="h-px flex-1 bg-border" />
          أو بالبطاقة
          <span className="h-px flex-1 bg-border" />
        </div>
      </div>

      <form onSubmit={submitCard} noValidate>
        <PaymentElement options={{ layout: 'tabs', wallets: { applePay: 'never', googlePay: 'never' } }} />

        <div aria-live="polite">{inlineError && <div className="mt-5"><Alert tone="danger">{inlineError}</Alert></div>}</div>

        <button
          type="submit"
          disabled={!stripe || !elements || working}
          aria-busy={working}
          className={cn(buttonClasses({ variant: 'primary', size: 'lg', block: true }), 'mt-6 h-[52px] text-[15px]')}
        >
          {working ? (
            <>
              <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
              {workingLabel}
            </>
          ) : (
            <>
              {label}
              <ArrowLeft aria-hidden className="h-4 w-4" />
            </>
          )}
        </button>
        {hasTrial && (
          <p className="mt-3 text-center text-[13px] leading-6 text-muted-foreground">ما ينخصم منك شي اليوم</p>
        )}

        <PromoField plan={plan} period={period} promo={promo} onPromo={onPromo} disabled={working} />
      </form>
    </div>
  );
}

function expressOptions(props: {
  hasTrial: boolean;
  regularAmount: number;
  amount: number;
  period: string;
  planName: string;
  chargeDateIso: string;
}): StripeExpressCheckoutElementOptions {
  const unit = props.period === 'yearly' ? 'year' : 'month';
  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://ai.modaafa.com';
  const firstCharge = new Date(props.chargeDateIso);
  return {
    buttonType: { applePay: 'subscribe', googlePay: 'subscribe' },
    buttonHeight: 52,
    // Only the two wallets. Link and the rest are other sign-ups, not one tap.
    paymentMethods: { applePay: 'auto', googlePay: 'auto', link: 'never', paypal: 'never', amazonPay: 'never', klarna: 'never' },
    layout: { maxColumns: 1, maxRows: 2, overflow: 'never' },
    applePay: {
      // Apple shows the customer exactly what the trial and the renewal are, in the sheet itself.
      recurringPaymentRequest: {
        paymentDescription: `مُضاعِف، ${props.planName}`,
        managementURL: `${origin}/billing`,
        regularBilling: {
          label: props.planName,
          amount: Math.round(props.regularAmount * 100),
          recurringPaymentIntervalUnit: unit,
          recurringPaymentIntervalCount: 1,
          ...(props.hasTrial && !Number.isNaN(firstCharge.getTime()) ? { recurringPaymentStartDate: firstCharge } : {}),
        },
        ...(props.hasTrial
          ? {
              trialBilling: {
                label: 'التجربة المجانية',
                amount: 0,
                ...(!Number.isNaN(firstCharge.getTime()) ? { recurringPaymentEndDate: firstCharge } : {}),
              },
            }
          : {}),
      },
    },
  };
}

/** Folded away by default: most customers have no code, and the field slows them down. */
function PromoField(props: {
  plan: string;
  period: string;
  promo: Promo | null;
  onPromo: (promo: Promo | null) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const apply = async () => {
    const code = value.trim();
    if (!code || checking) return;
    setChecking(true);
    setError(null);
    const result = await post('/api/billing/arabic/promo', { code, plan: props.plan, period: props.period });
    setChecking(false);
    if (!result.ok) {
      setError(failureFrom(result).message);
      return;
    }
    props.onPromo({
      code,
      label: String(result.json.label ?? ''),
      firstCharge: typeof result.json.first_charge_amount === 'number' ? result.json.first_charge_amount : null,
    });
    setOpen(false);
  };

  if (props.promo) {
    return (
      <div className="mt-6 flex items-center justify-between gap-3 border border-border px-3 py-2.5">
        <span className="flex items-center gap-2 text-sm">
          <Check aria-hidden className="h-4 w-4 flex-shrink-0" />
          <span className="font-numeric" dir="ltr">
            {props.promo.code}
          </span>
        </span>
        <button
          type="button"
          onClick={() => props.onPromo(null)}
          disabled={props.disabled}
          className="inline-flex items-center gap-1 text-[13px] font-semibold underline underline-offset-4 disabled:opacity-50"
        >
          <X aria-hidden className="h-3.5 w-3.5" />
          إزالة الكود
        </button>
      </div>
    );
  }

  if (!open) {
    return (
      <div className="mt-6 text-center">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="text-[13px] font-semibold text-muted-foreground underline decoration-border-strong underline-offset-4 hover:text-foreground"
        >
          عندي كود خصم
        </button>
      </div>
    );
  }

  return (
    <div className="mt-6">
      <label htmlFor="promo-code" className="text-[13px] font-semibold">
        كود الخصم
      </label>
      <div className="mt-2 flex gap-2">
        <input
          id="promo-code"
          autoFocus
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void apply();
            }
          }}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          dir="ltr"
          className="font-numeric h-11 min-w-0 flex-1 border border-border bg-card px-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
        />
        <button
          type="button"
          onClick={() => void apply()}
          disabled={checking || props.disabled || value.trim().length === 0}
          className={buttonClasses({ variant: 'outline', size: 'md' })}
        >
          {checking ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : null}
          تطبيق
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-[13px] leading-7 text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

function FallbackBlock(props: {
  message: string;
  action: string;
  plan: string;
  period: string;
  returnTo: string | null;
  onRetry: () => void;
}) {
  return (
    <div className="space-y-4">
      <Alert tone="warning">{props.message}</Alert>
      <p className="text-[13.5px] leading-7 text-muted-foreground">
        تقدر تعيد المحاولة، أو تكمل الدفع من صفحة Stripe الآمنة (بالإنجليزي) وتنفعّل نفس الخطة بنفس الشروط.
      </p>
      <div className="flex flex-wrap gap-3">
        <button type="button" onClick={props.onRetry} className={buttonClasses({ variant: 'primary', size: 'md' })}>
          أعد المحاولة
        </button>
        <form action={props.action} method="post">
          <input type="hidden" name="plan" value={props.plan} />
          <input type="hidden" name="period" value={props.period} />
          {props.returnTo ? <input type="hidden" name="return_to" value={props.returnTo} /> : null}
          <button type="submit" className={buttonClasses({ variant: 'outline', size: 'md' })}>
            أكمل من صفحة Stripe
          </button>
        </form>
      </div>
    </div>
  );
}

function SuccessView(props: {
  headingRef: React.RefObject<HTMLHeadingElement>;
  hasTrial: boolean;
  chargeDateText: string;
  redirectTo: string;
}) {
  return (
    <div className="mx-auto max-w-xl py-6 sm:py-12" role="status">
      <span aria-hidden className="flex h-12 w-12 items-center justify-center bg-signal text-signal-foreground">
        <Check className="h-6 w-6" />
      </span>
      <h1
        ref={props.headingRef}
        tabIndex={-1}
        className="mt-6 font-display text-[1.75rem] font-semibold leading-[1.3] outline-none sm:text-[2.25rem]"
      >
        {props.hasTrial ? 'بدأت تجربتك' : 'تم تفعيل اشتراكك'}
      </h1>
      <p className="mt-3 text-[15px] leading-8 text-muted-foreground">
        {props.hasTrial
          ? `ما انخصم شي اليوم. أول دفعة يوم ${props.chargeDateText}، وتلغي قبلها من صفحة الفوترة.`
          : 'وصلتنا الدفعة وفتحنا لك الخطة. إيصال الدفع يوصل على إيميلك من Stripe.'}
      </p>
      <Link href={props.redirectTo} className={cn(buttonClasses({ variant: 'primary', size: 'lg' }), 'mt-8')}>
        كمّل للمنصة
        <ArrowLeft aria-hidden className="h-4 w-4" />
      </Link>
      <p className="mt-4 text-[13px] text-muted-foreground">ننقلك تلقائياً خلال ثواني</p>
    </div>
  );
}

const TRIAL_USED_CODES = new Set(['card_trial_used', 'ads_account_trial_used']);

function failureHeading(failure: Failure) {
  if (TRIAL_USED_CODES.has(failure.code)) return 'التجربة المجانية مو متاحة لك';
  if (failure.code === 'activation_failed') return 'تم الدفع ولم يكتمل التفعيل';
  if (failure.code === 'subscription_conflict') return 'عندك اشتراك قائم';
  if (failure.code === 'terms_changed') return 'تغيّرت شروط العرض';
  if (failure.action === 'continue') return 'العملية ما انتهت بعد';
  return 'ما تمت العملية';
}

function FailureView(props: {
  headingRef: React.RefObject<HTMLHeadingElement>;
  failure: Failure;
  backPath: string;
  onRetry: () => void;
}) {
  const { failure } = props;
  // The page was drawn for a trial (or without one). When the answer changed, the
  // whole page is reloaded so the price and the dates match what will be charged.
  const reloads = failure.action === 'refresh' || TRIAL_USED_CODES.has(failure.code);
  // After a payment that went through or is still with the bank, paying again is the wrong advice.
  const mayRetry = failure.action === 'edit_card' || failure.action === 'retry' || reloads;
  const retryLabel = TRIAL_USED_CODES.has(failure.code)
    ? 'اشترك مباشرة'
    : failure.action === 'edit_card'
      ? 'جرّب بطاقة ثانية'
      : 'جرّب مرة ثانية';
  const pending = failure.action === 'continue' && ['payment_processing', 'payment_in_progress', 'payment_status_unknown'].includes(failure.code);
  return (
    <div className="mx-auto max-w-xl py-6 sm:py-12">
      <h1
        ref={props.headingRef}
        tabIndex={-1}
        className="font-display text-[1.75rem] font-semibold leading-[1.3] outline-none sm:text-[2.25rem]"
      >
        {failureHeading(failure)}
      </h1>
      <div className="mt-5" role="alert">
        <Alert tone={pending ? 'info' : 'danger'}>{failure.message}</Alert>
      </div>
      <div className="mt-8 flex flex-wrap gap-3">
        {mayRetry && (
          <button
            type="button"
            onClick={reloads ? () => window.location.reload() : props.onRetry}
            className={buttonClasses({ variant: 'primary', size: 'lg' })}
          >
            {retryLabel}
          </button>
        )}
        <Link
          href={failure.action === 'continue' ? '/billing' : props.backPath}
          className={buttonClasses({ variant: mayRetry ? 'outline' : 'primary', size: 'lg' })}
        >
          {failure.action === 'continue' ? 'افتح صفحة الفوترة' : 'رجوع'}
        </Link>
      </div>
    </div>
  );
}
