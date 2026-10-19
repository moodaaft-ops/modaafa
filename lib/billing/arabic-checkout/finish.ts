import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { arabicCheckoutStripe } from '@/lib/billing/stripe';
import { ONBOARDING_CHECKOUT_RETURN, ONBOARDING_CHECKOUT_SUCCESS_PATH } from '@/lib/billing/checkout-policy';
import { LiveSubscriptionConflictError } from '@/lib/billing/subscription-events';
import { sendOpsAlert } from '@/lib/notifications/email';
import { activateArabicSubscription } from '@/lib/billing/arabic-checkout/activate';
import { checkoutFailure } from '@/lib/billing/arabic-checkout/gate';
import { arabicCheckoutError } from '@/lib/billing/arabic-checkout/errors';

/** Where the customer lands, fixed on the server so it can never become an open redirect. */
export function destinationFor(returnTo: unknown) {
  return returnTo === ONBOARDING_CHECKOUT_RETURN ? ONBOARDING_CHECKOUT_SUCCESS_PATH : '/dashboard?subscribed=1';
}

/** Where the way back from a failure goes. */
export function backPathFor(returnTo: unknown) {
  return returnTo === ONBOARDING_CHECKOUT_RETURN ? '/onboarding/trial' : '/billing';
}

/**
 * The shared tail of /subscribe and /finalize: write the local row for a live
 * Stripe subscription and say what happened. Stripe has already accepted the
 * subscription by the time this runs, so the failure cases here are about the
 * guards and our own table, not the card.
 */
export async function finishArabicActivation(input: {
  userId: string;
  subscription: any;
  returnTo: unknown;
}): Promise<NextResponse> {
  const { userId, subscription, returnTo } = input;
  try {
    const result = await activateArabicSubscription({ admin: createAdminClient(), userId, subscription });
    if (!result.ok) {
      // The guard has already cancelled the subscription in Stripe and the row
      // is written as canceled. Nothing was charged: a trial charges nothing.
      return NextResponse.json(
        { ...failureBody(result.error), back: backPathFor(returnTo) },
        { status: 409 },
      );
    }
    return NextResponse.json({
      status: 'ok',
      subscription_status: result.status,
      trial_end: result.trialEnd,
      redirect: destinationFor(returnTo),
    });
  } catch (error) {
    if (error instanceof LiveSubscriptionConflictError) {
      // A different live subscription is already on file for this user. The new
      // one is the duplicate, so it is closed before it can bill, and ops are told.
      try {
        await arabicCheckoutStripe.cancelSubscription(subscription.id);
      } catch (cancelError) {
        console.error('Could not cancel a duplicate Arabic-checkout subscription', cancelError);
      }
      try {
        await sendOpsAlert({
          subject: 'تعارض اشتراك Stripe حي',
          message:
            'وصل اشتراك ثانٍ من صفحة الدفع العربية لمستخدم لديه اشتراك حي مختلف. أُلغي الاشتراك الجديد ويحتاج مراجعة Stripe لو انخصم منه شي.',
          details: {
            user_id: error.userId,
            incoming_subscription_id: error.incomingSubscriptionId,
            source: 'arabic_checkout',
          },
        });
      } catch (alertError) {
        console.error('Failed to send the subscription-conflict alert', alertError);
      }
      return checkoutFailure('subscription_conflict', 409);
    }
    // The subscription is live in Stripe but our row did not land. The webhook
    // writes it as well; the customer is told not to pay again.
    console.error('Arabic checkout activation failed', { userId, subscriptionId: subscription?.id, error });
    return checkoutFailure('activation_failed', 500);
  }
}

function failureBody(code: 'card_trial_used' | 'ads_account_trial_used') {
  const view = arabicCheckoutError(code);
  return { error: view.code, message: view.message, action: view.action };
}
