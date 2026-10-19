import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase/server';
import { checkRateLimit, rateLimitHeaders } from '@/lib/security/rate-limit';
import { isSameOriginRequest } from '@/lib/security/origin';
import { isModaafaOperator } from '@/lib/platform/operators';
import { readAccessOverrides } from '@/lib/billing/access-overrides';
import { hasActiveGoogleAdsAccount } from '@/lib/accounts/selection';
import { checkoutTrialDecision, getBillingCheckoutContext } from '@/lib/billing/checkout-policy';
import { isArabicCheckoutAvailable } from '@/lib/billing/arabic-checkout/flag';
import { arabicCheckoutError, type CheckoutErrorInput } from '@/lib/billing/arabic-checkout/errors';
import { ArabicCheckoutError } from '@/lib/billing/arabic-checkout/flow';

/**
 * The checks every Arabic-checkout request passes before Stripe is touched. They
 * are the same ones the hosted path runs in `/api/billing/checkout` and
 * `/api/billing/start-trial`, in the same order, so the two entry points cannot
 * disagree about who may subscribe or whether a trial is offered.
 */
export function checkoutFailure(code: string | CheckoutErrorInput, status: number, headers?: Record<string, string>) {
  const view = arabicCheckoutError(code);
  return NextResponse.json({ error: view.code, message: view.message, action: view.action }, { status, headers });
}

type SupabaseClient = Awaited<ReturnType<typeof createServerClient>>;
type AuthUser = { id: string; email?: string | null };

export type LightGate =
  | { ok: false; response: NextResponse }
  | { ok: true; supabase: SupabaseClient; user: AuthUser };

/** Flag, origin, login and a rate limit. Enough for a request that moves no money. */
export async function lightGate(req: NextRequest, scope: string, limit: number): Promise<LightGate> {
  // Off means it does not exist: the old path is the only path.
  if (!isArabicCheckoutAvailable()) {
    return { ok: false, response: NextResponse.json({ error: 'not_found' }, { status: 404 }) };
  }
  if (!isSameOriginRequest(req)) return { ok: false, response: checkoutFailure('invalid_origin', 403) };

  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, response: checkoutFailure('unauthorized', 401) };

  try {
    const rateLimit = await checkRateLimit({ req, scope, limit, windowSeconds: 3600, identifier: user.id });
    if (!rateLimit.allowed) {
      return { ok: false, response: checkoutFailure('too_many_requests', 429, rateLimitHeaders(rateLimit)) };
    }
  } catch {
    return { ok: false, response: checkoutFailure('security_service_unavailable', 503) };
  }
  return { ok: true, supabase, user: user as AuthUser };
}

export type FullGate =
  | { ok: false; response: NextResponse }
  | {
      ok: true;
      supabase: SupabaseClient;
      user: AuthUser & { email: string };
      stripeCustomerId: string | null;
      trialDays: number;
    };

/** Everything the hosted checkout checks, ending in the server's own trial decision. */
export async function fullGate(req: NextRequest, scope: string, limit: number): Promise<FullGate> {
  const light = await lightGate(req, scope, limit);
  if (!light.ok) return light;
  const { supabase, user } = light;
  if (!user.email) return { ok: false, response: checkoutFailure('unauthorized', 401) };

  if (isModaafaOperator(user.email)) return { ok: false, response: checkoutFailure('internal_access', 409) };
  if ((await readAccessOverrides(supabase, user.id)).suspended) {
    return { ok: false, response: checkoutFailure('account_suspended', 403) };
  }

  try {
    const billing = await getBillingCheckoutContext(supabase, user.id, user.email);
    if (billing.activeSubscriptionId) return { ok: false, response: checkoutFailure('already_subscribed', 409) };

    // A trial with no linked, active Google Ads account can never produce a plan
    // or a recommendation, so it only burns the one-time trial.
    if (!(await hasActiveGoogleAdsAccount(supabase, user.id))) {
      return { ok: false, response: checkoutFailure('google_ads_account_required', 409) };
    }

    // The eligibility check could not run: never fall through to a charge.
    const decision = checkoutTrialDecision(billing);
    if (decision.action === 'blocked') return { ok: false, response: checkoutFailure(decision.error, 503) };

    return {
      ok: true,
      supabase,
      user: { id: user.id, email: user.email },
      stripeCustomerId: billing.stripeCustomerId,
      trialDays: decision.trialDays,
    };
  } catch (error) {
    console.error('Arabic checkout gate failed', error);
    return { ok: false, response: checkoutFailure('checkout_failed', 500) };
  }
}

/** Turns whatever was thrown into the input `arabicCheckoutError` reads, and the HTTP status to use. */
export function describeFailure(error: unknown): { input: CheckoutErrorInput; status: number } {
  if (error instanceof ArabicCheckoutError) {
    return { input: { code: error.code, decline_code: error.declineCode }, status: statusForCode(error.code) };
  }
  const stripeError = error as { type?: string; code?: string; decline_code?: string } | null;
  switch (stripeError?.type) {
    case 'StripeCardError':
      return { input: { code: stripeError.code, decline_code: stripeError.decline_code }, status: 402 };
    case 'StripeConnectionError':
      return { input: { code: 'api_connection_error' }, status: 503 };
    case 'StripeRateLimitError':
      return { input: { code: 'rate_limit' }, status: 429 };
    default:
      return { input: { code: 'checkout_failed' }, status: 500 };
  }
}

function statusForCode(code: string) {
  if (code.startsWith('promo_')) return 400;
  if (code === 'already_subscribed' || code === 'terms_changed') return 409;
  if (code === 'payment_processing') return 202;
  if (code === 'payment_in_progress') return 409;
  if (code === 'payment_status_unknown') return 502;
  if (code === 'setup_not_completed') return 409;
  if (code === 'checkout_failed') return 500;
  return 402;
}
