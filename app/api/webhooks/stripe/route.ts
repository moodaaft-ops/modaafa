import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import {
  constructWebhookEvent,
  planFromSubscription,
  retrieveStripeSubscription,
} from '@/lib/billing/stripe';
import {
  paymentFailedEmail,
  sendEmail,
  sendOpsAlert,
  subscriptionWelcomeEmail,
  trialEndingEmail,
} from '@/lib/notifications/email';
import { recordTrialGrant } from '@/lib/billing/checkout-policy';
import {
  applySubscriptionEvent,
  subscriptionEventWasApplied,
} from '@/lib/billing/subscription-events';
import { recordPaidInvoice } from '@/lib/billing/invoices';
import {
  claimStripeWebhookEvent,
  completeStripeWebhookEvent,
  failStripeWebhookEvent,
} from '@/lib/billing/webhook-ledger';

/**
 * POST /api/webhooks/stripe
 *
 * Handles Stripe lifecycle events:
 * - checkout.session.completed → create subscription row
 * - customer.subscription.created → persist a newly created subscription
 * - customer.subscription.updated → update status, period
 * - customer.subscription.deleted → mark canceled
 * - invoice.payment_succeeded → record invoice
 * - invoice.payment_failed → mark past_due
 *
 * MUST receive raw body for signature verification.
 */
export const runtime = 'nodejs';
// This handler makes a Stripe round trip plus several Supabase writes. On the
// platform default (10-15s) it could be killed mid-flight, leaving the event
// row stuck in `processing`.
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const sig = req.headers.get('stripe-signature');
  if (!sig) return NextResponse.json({ error: 'no_signature' }, { status: 400 });

  const rawBody = await req.text();
  let event;
  try {
    event = constructWebhookEvent(rawBody, sig);
  } catch (err) {
    return NextResponse.json({ error: 'invalid_signature' }, { status: 400 });
  }

  let supabase;
  try {
    supabase = createAdminClient();
  } catch (error) {
    console.error('Stripe webhook requires Supabase service role', error);
    return NextResponse.json({ error: 'service_role_missing' }, { status: 503 });
  }

  try {
    const claim = await claimStripeWebhookEvent(supabase, event.id, event.type);
    if (claim === 'already_completed') {
      return NextResponse.json({ received: true, duplicate: true });
    }
    if (claim === 'in_flight') {
      // Do NOT answer 200 here. Stripe treats 2xx as delivered and stops
      // retrying, so an event whose first attempt died mid-flight (function
      // timeout, OOM, instance recycle) was silently dropped forever — a lost
      // `customer.subscription.deleted` means a cancelled customer keeps full
      // access. 409 keeps Stripe's retry schedule alive.
      return NextResponse.json({ error: 'event_in_flight' }, { status: 409 });
    }

    const eventCreatedAt = new Date(event.created * 1000).toISOString();

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as any;
        const userId = session.metadata?.userId;
        if (!userId) break;

        const subscriptionId =
          typeof session.subscription === 'string'
            ? session.subscription
            : session.subscription?.id;
        if (!subscriptionId) throw new Error('Completed checkout is missing its Stripe subscription');
        // Always retrieve the current Stripe object. Webhooks can arrive out of
        // order, so the event payload may describe a state that is already old.
        const stripeSubscription = await retrieveStripeSubscription(subscriptionId);

        // Derive the plan from the price actually billed, not from metadata:
        // metadata is a snapshot written once at creation and Stripe never
        // updates it when the price changes.
        const resolved = planFromSubscription(stripeSubscription);

        const writeResult = await applySubscriptionEvent(supabase, {
            user_id: userId,
            plan: resolved.plan,
            billing_period: resolved.period,
            status: normalizeSubscriptionStatus(stripeSubscription.status),
            last_event_at: eventCreatedAt,
            stripe_subscription_id: subscriptionId,
            stripe_customer_id:
              typeof session.customer === 'string' ? session.customer : session.customer?.id,
            trial_ends_at: stripeTimestamp(stripeSubscription.trial_end),
            current_period_start: stripeTimestamp(stripeSubscription.current_period_start),
            current_period_end: stripeTimestamp(stripeSubscription.current_period_end),
            canceled_at:
              normalizeSubscriptionStatus(stripeSubscription.status) === 'canceled'
                ? stripeTimestamp(stripeSubscription.canceled_at) ?? eventCreatedAt
                : null,
        });
        if (subscriptionEventWasApplied(writeResult) && stripeSubscription.trial_end) {
          await recordTrialGrant({
            supabase,
            userId,
            stripeSubscriptionId: subscriptionId,
            source: 'stripe_webhook',
          });
        }
        if (subscriptionEventWasApplied(writeResult)) {
          await safeUserEmail(supabase, userId, subscriptionWelcomeEmail());
        }
        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const eventSubscription = event.data.object as any;
        // Reading the live object prevents an old event delivered late from
        // resurrecting a subscription that Stripe has since cancelled.
        const sub = await retrieveStripeSubscription(eventSubscription.id);
        const userId = sub.metadata?.userId ?? eventSubscription.metadata?.userId;
        const resolved = planFromSubscription(sub);
        const row = {
          ...(userId ? { user_id: userId } : {}),
          plan: resolved.plan,
          billing_period: resolved.period,
          status: normalizeSubscriptionStatus(sub.status),
          stripe_subscription_id: sub.id,
          stripe_customer_id: typeof sub.customer === 'string' ? sub.customer : sub.customer?.id,
          trial_ends_at: stripeTimestamp(sub.trial_end),
          current_period_start: stripeTimestamp(sub.current_period_start),
          current_period_end: stripeTimestamp(sub.current_period_end),
          last_event_at: eventCreatedAt,
          canceled_at:
            normalizeSubscriptionStatus(sub.status) === 'canceled'
              ? stripeTimestamp(sub.canceled_at) ?? eventCreatedAt
              : null,
        };

        const writeResult = await applySubscriptionEvent(supabase, row);
        if (subscriptionEventWasApplied(writeResult) && userId && sub.trial_end) {
          await recordTrialGrant({
            supabase,
            userId,
            stripeSubscriptionId: sub.id,
            source: 'stripe_webhook',
          });
        }
        break;
      }

      case 'customer.subscription.trial_will_end': {
        const sub = event.data.object as any;
        const { data: trialing } = await supabase
          .from('subscriptions')
          .select('user_id')
          .eq('stripe_subscription_id', sub.id)
          .maybeSingle();
        if (trialing?.user_id) {
          await safeUserEmail(supabase, trialing.user_id, trialEndingEmail(stripeTimestamp(sub.trial_end)));
        }
        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object as any;
        const invoiceSubscriptionId = stripeObjectId(invoice.subscription);
        if (!invoiceSubscriptionId) break;
        const stripeSubscription = await retrieveStripeSubscription(invoiceSubscriptionId);
        await applySubscriptionEvent(
          supabase,
          subscriptionSnapshotRow(stripeSubscription, eventCreatedAt),
        );
        const { data: sub, error: subscriptionError } = await supabase
          .from('subscriptions')
          .select('id, user_id')
          .eq('stripe_subscription_id', invoiceSubscriptionId)
          .maybeSingle();
        throwOnSupabaseError('find invoice subscription', subscriptionError);

        if (sub) {
          // Plain INSERT tolerating 23505 — NOT upsert. The uniqueness index is
          // partial (`WHERE invoice_number IS NOT NULL`) and PostgREST's
          // `onConflict` cannot carry the predicate, so the old upsert failed
          // every delivery with 42P10. See lib/billing/invoices.ts.
          await recordPaidInvoice(supabase, {
            subscriptionRowId: sub.id,
            userId: sub.user_id,
            invoice,
          });
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as any;
        const invoiceSubscriptionId = stripeObjectId(invoice.subscription);
        if (!invoiceSubscriptionId) break;
        const stripeSubscription = await retrieveStripeSubscription(invoiceSubscriptionId);
        const writeResult = await applySubscriptionEvent(
          supabase,
          subscriptionSnapshotRow(stripeSubscription, eventCreatedAt),
        );
        const status = normalizeSubscriptionStatus(stripeSubscription.status);
        const userId = stripeSubscription.metadata?.userId;
        if (subscriptionEventWasApplied(writeResult) && status === 'past_due' && userId) {
          await safeUserEmail(supabase, userId, paymentFailedEmail());
        }
        break;
      }
    }

    await completeStripeWebhookEvent(supabase, event.id);
  } catch (error) {
    console.error('Stripe webhook processing failed', {
      eventId: event.id,
      eventType: event.type,
      error,
    });
    try {
      await failStripeWebhookEvent(supabase, event.id, errorText(error));
      await sendOpsAlert({
        subject: 'فشل Stripe webhook',
        message: `تعذر معالجة الحدث ${event.type}. سيعيد Stripe المحاولة تلقائياً.`,
        details: { event_id: event.id, event_type: event.type, error: errorText(error) },
      });
    } catch (alertError) {
      console.error('Failed to send Stripe webhook alert', alertError);
    }
    return NextResponse.json({ error: 'processing_failed' }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}

async function safeUserEmail(
  supabase: any,
  userId: string,
  email: { subject: string; html: string }
) {
  try {
    const { data: profile, error } = await supabase
      .from('users')
      .select('email')
      .eq('id', userId)
      .maybeSingle();
    if (error) throw error;
    if (profile?.email) await sendEmail({ to: profile.email, ...email });
  } catch (error) {
    console.error('Failed to send Stripe lifecycle email', { userId, error });
  }
}

function throwOnSupabaseError(operation: string, error: unknown) {
  if (!error) return;
  throw new Error(`Failed to ${operation}`, { cause: error });
}

function normalizeSubscriptionStatus(status?: string) {
  const allowed = ['trialing', 'active', 'past_due', 'canceled', 'paused'];
  if (status && allowed.includes(status)) return status;
  if (status === 'unpaid' || status === 'incomplete') return 'past_due';
  return 'paused';
}

function stripeTimestamp(value?: number | null) {
  return value ? new Date(value * 1000).toISOString() : null;
}

function stripeObjectId(value: unknown) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'id' in value) return String(value.id);
  return null;
}

function subscriptionSnapshotRow(subscription: any, eventCreatedAt: string) {
  const resolved = planFromSubscription(subscription);
  const userId = subscription.metadata?.userId;
  const status = normalizeSubscriptionStatus(subscription.status);
  return {
    ...(userId ? { user_id: userId } : {}),
    plan: resolved.plan,
    billing_period: resolved.period,
    status,
    stripe_subscription_id: subscription.id,
    stripe_customer_id:
      typeof subscription.customer === 'string'
        ? subscription.customer
        : subscription.customer?.id,
    trial_ends_at: stripeTimestamp(subscription.trial_end),
    current_period_start: stripeTimestamp(subscription.current_period_start),
    current_period_end: stripeTimestamp(subscription.current_period_end),
    canceled_at:
      status === 'canceled'
        ? stripeTimestamp(subscription.canceled_at) ?? eventCreatedAt
        : null,
    last_event_at: eventCreatedAt,
  };
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
