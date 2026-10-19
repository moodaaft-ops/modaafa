'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { loadStripe, type Stripe } from '@stripe/stripe-js';
import { ArrowLeft, Check, Loader2, Lock, X } from 'lucide-react';
import { Alert } from '@/lib/ui/alert';
import { buttonClasses } from '@/lib/ui/button';
import { cn, formatCurrency } from '@/lib/utils';
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
    const view = arabicCheckoutError(isNetworkFailure(error) ? 'network_error' : 'checkout_failed');
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

  const money = useCallback((value: number) => formatCurrency(value, props.currency.toUpperCase()), [props.currency]);
  const hasTrial = trialDays > 0;
  const chargeAmount = promo?.firstCharge ?? props.amount;

  return (
    <div className="mx-auto max-w-5xl">
      {phase === 'success' ? (
        <SuccessView
          headingRef={headingRef}
          hasTrial={hasTrial}
          chargeDateText={props.chargeDateText}
          redirectTo={redirectTo ?? '/dashboard?subscribed=1'}
        />
      ) : phase === 'failed' && failure ? (
        <FailureView
          headingRef={headingRef}
          failure={failure}
          backPath={failure.back ?? backPath}
          onRetry={() => void prepare()}
        />
      ) : (
        <>
          <div className="mb-8 max-w-2xl">
            <h1 className="font-display text-[1.7rem] font-semibold leading-[1.35] text-balance sm:text-[2.1rem]">
              {hasTrial ? `ابدأ تجربتك ${props.trialLabel}` : `اشترك في ${props.planName}`}
            </h1>
            <p className="mt-3 text-[15px] leading-8 text-muted-foreground">
              {hasTrial
                ? `ما ينخصم شي اليوم. أول خصم يوم ${props.chargeDateText}، وتقدر تلغي قبله من صفحة الفوترة.`
                : `ينخصم المبلغ اليوم، ثم يتجدد ${props.periodWord} من نفس البطاقة.`}
            </p>
          </div>

          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_21rem] lg:items-start lg:gap-10">
            <section aria-labelledby="summary-title" className="order-1 lg:order-2">
              <div className="surface-card p-5">
                <h2 id="summary-title" className="text-sm font-semibold text-muted-foreground">
                  {props.planName}، {props.periodWord}
                </h2>
                <ol className="mt-4 space-y-0">
                  <li className="flex items-center justify-between gap-3 border-b border-border py-3">
                    <span className="flex items-center gap-2.5 text-sm font-semibold">
                      <span aria-hidden className="h-2.5 w-2.5 flex-shrink-0 bg-signal" />
                      اليوم
                    </span>
                    <span className="font-numeric text-base font-semibold" dir="ltr">
                      {money(hasTrial ? 0 : chargeAmount)}
                    </span>
                  </li>
                  {hasTrial && (
                    <li className="flex items-center justify-between gap-3 py-3">
                      <span className="flex items-center gap-2.5 text-sm">
                        <span aria-hidden className="h-2.5 w-2.5 flex-shrink-0 border border-border-strong" />
                        {props.chargeDateText}
                      </span>
                      <span className="font-numeric text-base font-semibold" dir="ltr">
                        {money(chargeAmount)}
                      </span>
                    </li>
                  )}
                </ol>
                {promo && (
                  <p className="mt-1 border-t border-border pt-3 text-[13px] leading-7 text-foreground">{promo.label}</p>
                )}
                <p className="mt-3 text-[13px] leading-7 text-muted-foreground">
                  بعد الخصم الأول يتجدد{' '}
                  <span className="font-numeric font-semibold text-foreground">{props.amountText}</span>{' '}
                  {props.periodWord}، وتلغي متى ما بغيت من صفحة الفوترة.
                </p>
              </div>
            </section>

            <section aria-labelledby="card-title" className="order-2 lg:order-1">
              <div className="surface-card p-5 sm:p-6">
                <h2 id="card-title" className="text-base font-semibold">
                  بيانات البطاقة
                </h2>

                {phase === 'loading' && (
                  <div className="mt-6 space-y-3" role="status" aria-live="polite">
                    <div className="h-11 animate-pulse bg-muted" />
                    <div className="grid grid-cols-2 gap-3">
                      <div className="h-11 animate-pulse bg-muted" />
                      <div className="h-11 animate-pulse bg-muted" />
                    </div>
                    <span className="sr-only">جاري تجهيز خانة البطاقة</span>
                  </div>
                )}

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
                    options={{ clientSecret: intent.clientSecret, locale: 'ar', appearance: appearance() }}
                  >
                    <CardForm
                      intent={intent}
                      hasTrial={hasTrial}
                      amountText={money(chargeAmount)}
                      plan={plan}
                      period={period}
                      returnTo={returnTo}
                      promo={promo}
                      currency={props.currency}
                      money={money}
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
              <p className="mt-3 flex items-start gap-2 text-[13px] leading-7 text-muted-foreground">
                <Lock aria-hidden className="mt-1.5 h-3.5 w-3.5 flex-shrink-0" />
                <span>بيانات البطاقة تُكتب في خانة Stripe مباشرة، وما تمر على خوادم مُضاعِف.</span>
              </p>
              <p className="mt-2">
                <Link href={backPath} className="text-[13px] font-semibold text-foreground underline underline-offset-4">
                  رجوع بدون دفع
                </Link>
              </p>
            </section>
          </div>
        </>
      )}
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
      colorDanger: dark ? '#FF8A80' : '#B3261E',
      borderRadius: '0px',
      fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
      spacingUnit: '4px',
    },
  };
}

function CardForm(props: {
  intent: Intent;
  hasTrial: boolean;
  amountText: string;
  plan: string;
  period: string;
  returnTo: string | null;
  promo: Promo | null;
  currency: string;
  money: (value: number) => string;
  onPromo: (promo: Promo | null) => void;
  onSuccess: (destination: string) => void;
  onFailure: (failure: Failure) => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const { intent, hasTrial, plan, period, returnTo, promo, onPromo, onSuccess, onFailure } = props;
  const [busy, setBusy] = useState<Busy>(null);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [promoInput, setPromoInput] = useState('');
  const [promoError, setPromoError] = useState<string | null>(null);
  // A ref, not state: two clicks in the same frame both see the same stale state.
  const lock = useRef(false);

  const applyPromo = async () => {
    const code = promoInput.trim();
    if (!code || busy) return;
    setBusy('promo');
    setPromoError(null);
    const result = await post('/api/billing/arabic/promo', { code, plan, period });
    setBusy(null);
    if (!result.ok) {
      setPromoError(failureFrom(result).message);
      return;
    }
    onPromo({
      code,
      label: String(result.json.label ?? ''),
      firstCharge: typeof result.json.first_charge_amount === 'number' ? result.json.first_charge_amount : null,
    });
  };

  const finishWith = (result: ApiResult) => {
    if (result.ok && result.json.status === 'ok') {
      const destination = String(result.json.redirect ?? '');
      onSuccess(destination.startsWith('/') && !destination.startsWith('//') ? destination : '/dashboard?subscribed=1');
      return true;
    }
    return false;
  };

  const submit = async (event: React.FormEvent) => {
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
      if (saved.setupIntent?.status !== 'succeeded') {
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

      if (subscribed.ok && subscribed.json.status === 'requires_action') {
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
    } catch (error) {
      const view = arabicCheckoutError(isNetworkFailure(error) ? 'network_error' : 'checkout_failed');
      setInlineError(view.message);
    } finally {
      lock.current = false;
      setBusy(null);
    }
  };

  const working = busy === 'card' || busy === 'activate' || busy === 'bank';
  const label = hasTrial ? 'ابدأ التجربة' : `ادفع ${props.amountText}`;
  const workingLabel =
    busy === 'bank' ? 'بانتظار تأكيد البنك...' : busy === 'activate' ? 'جاري تفعيل اشتراكك...' : 'جاري التحقق من البطاقة...';

  return (
    <form onSubmit={submit} className="mt-5" noValidate>
      <PaymentElement options={{ layout: 'tabs', wallets: { applePay: 'never', googlePay: 'never' } }} />

      <div className="mt-6 border-t border-border pt-5">
        <label htmlFor="promo-code" className="text-sm font-semibold">
          عندك كود خصم؟
        </label>
        {promo ? (
          <div className="mt-2 flex items-center justify-between gap-3 border border-border px-3 py-2.5">
            <span className="flex items-center gap-2 text-sm">
              <Check aria-hidden className="h-4 w-4 flex-shrink-0" />
              <span className="font-numeric" dir="ltr">
                {promo.code}
              </span>
            </span>
            <button
              type="button"
              onClick={() => onPromo(null)}
              disabled={working}
              className="inline-flex items-center gap-1 text-[13px] font-semibold underline underline-offset-4 disabled:opacity-50"
            >
              <X aria-hidden className="h-3.5 w-3.5" />
              إزالة
            </button>
          </div>
        ) : (
          <div className="mt-2 flex gap-2">
            <input
              id="promo-code"
              value={promoInput}
              onChange={(event) => setPromoInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void applyPromo();
                }
              }}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              dir="ltr"
              className="font-numeric h-11 min-w-0 flex-1 border border-border bg-background px-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
            />
            <button
              type="button"
              onClick={() => void applyPromo()}
              disabled={busy !== null || promoInput.trim().length === 0}
              className={buttonClasses({ variant: 'outline', size: 'md' })}
            >
              {busy === 'promo' ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : null}
              تطبيق
            </button>
          </div>
        )}
        {promoError && (
          <p role="alert" className="mt-2 text-[13px] leading-7 text-danger">
            {promoError}
          </p>
        )}
      </div>

      <div aria-live="polite" className="mt-5">
        {inlineError && <Alert tone="danger">{inlineError}</Alert>}
      </div>

      <button
        type="submit"
        disabled={!stripe || !elements || working}
        aria-busy={working}
        className={cn(buttonClasses({ variant: 'primary', size: 'lg', block: true }), 'mt-5')}
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
    </form>
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
    <div className="mt-5 space-y-4">
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
    <div className="mx-auto max-w-xl py-6 text-center sm:py-12" role="status">
      <span aria-hidden className="mx-auto mb-6 block h-4 w-4 bg-signal" />
      <h1
        ref={props.headingRef}
        tabIndex={-1}
        className="font-display text-[1.7rem] font-semibold leading-[1.35] outline-none sm:text-[2.1rem]"
      >
        {props.hasTrial ? 'بدأت تجربتك' : 'تم تفعيل اشتراكك'}
      </h1>
      <p className="mt-3 text-[15px] leading-8 text-muted-foreground">
        {props.hasTrial
          ? `ما انخصم شي اليوم. أول خصم يوم ${props.chargeDateText}، وتلغي قبله من صفحة الفوترة.`
          : 'وصلتنا الدفعة وفتحنا لك الخطة. إيصال الدفع يوصل على إيميلك من Stripe.'}
      </p>
      <Link href={props.redirectTo} className={cn(buttonClasses({ variant: 'primary', size: 'lg' }), 'mt-8')}>
        كمّل للمنصة
        <ArrowLeft aria-hidden className="h-4 w-4" />
      </Link>
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
  return (
    <div className="mx-auto max-w-xl py-6 sm:py-12">
      <h1
        ref={props.headingRef}
        tabIndex={-1}
        className="font-display text-[1.7rem] font-semibold leading-[1.35] outline-none sm:text-[2.1rem]"
      >
        {failureHeading(failure)}
      </h1>
      <div className="mt-4" role="alert">
        <Alert tone={failure.action === 'continue' && failure.code === 'payment_processing' ? 'info' : 'danger'}>
          {failure.message}
        </Alert>
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
