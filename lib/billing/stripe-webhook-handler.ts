import { NextRequest, NextResponse } from 'next/server';
import type Stripe from 'stripe';
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

const defaultDependencies = {
  createAdminClient,
  constructWebhookEvent,
  planFromSubscription,
  retrieveStripeSubscription,
  paymentFailedEmail,
  sendEmail,
  sendOpsAlert,
  subscriptionWelcomeEmail,
  trialEndingEmail,
  recordTrialGrant,
  applySubscriptionEvent,
  subscriptionEventWasApplied,
  recordPaidInvoice,
  claimStripeWebhookEvent,
  completeStripeWebhookEvent,
  failStripeWebhookEvent,
};

export type StripeWebhookDependencies = typeof defaultDependencies;

/**
 * Build the production Stripe webhook handler with explicit dependencies.
 *
 * The route uses the defaults. Tests replace Stripe and database boundaries so
 * they exercise the real request, signature, claim and ordering control flow
 * without contacting Stripe, Supabase or Resend.
 */
export function createStripeWebhookHandler(
  overrides: Partial<StripeWebhookDependencies> = {},
) {
  const dependencies: StripeWebhookDependencies = {
    ...defaultDependencies,
    ...overrides,
  };

  return async function handleStripeWebhook(req: NextRequest) {
    const sig = req.headers.get('stripe-signature');
    if (!sig) return NextResponse.json({ error: 'no_signature' }, { status: 400 });

    const rawBody = await req.text();
    let event: Stripe.Event;
    try {
      event = dependencies.constructWebhookEvent(rawBody, sig);
    } catch {
      return NextResponse.json({ error: 'invalid_signature' }, { status: 400 });
    }

    let supabase: ReturnType<typeof createAdminClient>;
    try {
      supabase = dependencies.createAdminClient();
    } catch (error) {
      console.error('Stripe webhook requires Supabase service role', error);
      return NextResponse.json({ error: 'service_role_missing' }, { status: 503 });
    }

    try {
      const claim = await dependencies.claimStripeWebhookEvent(
        supabase,
        event.id,
        event.type,
      );
      if (claim === 'already_completed') {
        return NextResponse.json({ received: true, duplicate: true });
      }
      if (claim === 'in_flight') {
        // Stripe must retry if the first worker disappears before completing.
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
          if (!subscriptionId) {
            throw new Error('Completed checkout is missing its Stripe subscription');
          }
          const stripeSubscription = await dependencies.retrieveStripeSubscription(
            subscriptionId,
          );
          const resolved = dependencies.planFromSubscription(stripeSubscription);

          const writeResult = await dependencies.applySubscriptionEvent(supabase, {
            user_id: userId,
            plan: resolved.plan,
            billing_period: resolved.period,
            status: normalizeSubscriptionStatus(stripeSubscription.status),
            last_event_at: eventCreatedAt,
            stripe_subscription_id: subscriptionId,
            stripe_customer_id:
              typeof session.customer === 'string'
                ? session.customer
                : session.customer?.id,
            trial_ends_at: stripeTimestamp(stripeSubscription.trial_end),
            current_period_start: stripeTimestamp(stripeSubscription.current_period_start),
            current_period_end: stripeTimestamp(stripeSubscription.current_period_end),
            canceled_at:
              normalizeSubscriptionStatus(stripeSubscription.status) === 'canceled'
                ? stripeTimestamp(stripeSubscription.canceled_at) ?? eventCreatedAt
                : null,
          });
          if (
            dependencies.subscriptionEventWasApplied(writeResult) &&
            stripeSubscription.trial_end
          ) {
            await dependencies.recordTrialGrant({
              supabase,
              userId,
              stripeSubscriptionId: subscriptionId,
              source: 'stripe_webhook',
            });
          }
          if (dependencies.subscriptionEventWasApplied(writeResult)) {
            await safeUserEmail(
              dependencies,
              supabase,
              userId,
              dependencies.subscriptionWelcomeEmail(),
            );
          }
          break;
        }

        case 'customer.subscription.created':
        case 'customer.subscription.updated':
        case 'customer.subscription.deleted': {
          const eventSubscription = event.data.object as any;
          // A live read prevents a delayed update from reviving a subscription
          // that Stripe has already cancelled.
          const subscription = await dependencies.retrieveStripeSubscription(
            eventSubscription.id,
          );
          const userId =
            subscription.metadata?.userId ?? eventSubscription.metadata?.userId;
          const resolved = dependencies.planFromSubscription(subscription);
          const row = {
            ...(userId ? { user_id: userId } : {}),
            plan: resolved.plan,
            billing_period: resolved.period,
            status: normalizeSubscriptionStatus(subscription.status),
            stripe_subscription_id: subscription.id,
            stripe_customer_id:
              typeof subscription.customer === 'string'
                ? subscription.customer
                : subscription.customer?.id,
            trial_ends_at: stripeTimestamp(subscription.trial_end),
            current_period_start: stripeTimestamp(subscription.current_period_start),
            current_period_end: stripeTimestamp(subscription.current_period_end),
            last_event_at: eventCreatedAt,
            canceled_at:
              normalizeSubscriptionStatus(subscription.status) === 'canceled'
                ? stripeTimestamp(subscription.canceled_at) ?? eventCreatedAt
                : null,
          };

          const writeResult = await dependencies.applySubscriptionEvent(supabase, row);
          if (
            dependencies.subscriptionEventWasApplied(writeResult) &&
            userId &&
            subscription.trial_end
          ) {
            await dependencies.recordTrialGrant({
              supabase,
              userId,
              stripeSubscriptionId: subscription.id,
              source: 'stripe_webhook',
            });
          }
          break;
        }

        case 'customer.subscription.trial_will_end': {
          const subscription = event.data.object as any;
          const { data: trialing } = await supabase
            .from('subscriptions')
            .select('user_id')
            .eq('stripe_subscription_id', subscription.id)
            .maybeSingle();
          if (trialing?.user_id) {
            await safeUserEmail(
              dependencies,
              supabase,
              trialing.user_id,
              dependencies.trialEndingEmail(stripeTimestamp(subscription.trial_end)),
            );
          }
          break;
        }

        case 'invoice.payment_succeeded': {
          const invoice = event.data.object as any;
          const subscriptionId = stripeObjectId(invoice.subscription);
          if (!subscriptionId) break;
          const subscription = await dependencies.retrieveStripeSubscription(subscriptionId);
          await dependencies.applySubscriptionEvent(
            supabase,
            subscriptionSnapshotRow(dependencies, subscription, eventCreatedAt),
          );
          const { data: localSubscription, error: subscriptionError } = await supabase
            .from('subscriptions')
            .select('id, user_id')
            .eq('stripe_subscription_id', subscriptionId)
            .maybeSingle();
          throwOnSupabaseError('find invoice subscription', subscriptionError);

          if (localSubscription) {
            await dependencies.recordPaidInvoice(supabase, {
              subscriptionRowId: localSubscription.id,
              userId: localSubscription.user_id,
              invoice,
            });
          }
          break;
        }

        case 'invoice.payment_failed': {
          const invoice = event.data.object as any;
          const subscriptionId = stripeObjectId(invoice.subscription);
          if (!subscriptionId) break;
          const subscription = await dependencies.retrieveStripeSubscription(subscriptionId);
          const writeResult = await dependencies.applySubscriptionEvent(
            supabase,
            subscriptionSnapshotRow(dependencies, subscription, eventCreatedAt),
          );
          const status = normalizeSubscriptionStatus(subscription.status);
          const userId = subscription.metadata?.userId;
          if (
            dependencies.subscriptionEventWasApplied(writeResult) &&
            status === 'past_due' &&
            userId
          ) {
            await safeUserEmail(
              dependencies,
              supabase,
              userId,
              dependencies.paymentFailedEmail(),
            );
          }
          break;
        }
      }

      await dependencies.completeStripeWebhookEvent(supabase, event.id);
    } catch (error) {
      console.error('Stripe webhook processing failed', {
        eventId: event.id,
        eventType: event.type,
        error,
      });
      try {
        await dependencies.failStripeWebhookEvent(supabase, event.id, errorText(error));
        await dependencies.sendOpsAlert({
          subject: 'فشل Stripe webhook',
          message: `تعذر معالجة الحدث ${event.type}. سيعيد Stripe المحاولة تلقائياً.`,
          details: {
            event_id: event.id,
            event_type: event.type,
            error: errorText(error),
          },
        });
      } catch (alertError) {
        console.error('Failed to send Stripe webhook alert', alertError);
      }
      return NextResponse.json({ error: 'processing_failed' }, { status: 500 });
    }

    return NextResponse.json({ received: true });
  };
}

async function safeUserEmail(
  dependencies: StripeWebhookDependencies,
  supabase: ReturnType<typeof createAdminClient>,
  userId: string,
  email: { subject: string; html: string },
) {
  try {
    const { data: profile, error } = await supabase
      .from('users')
      .select('email')
      .eq('id', userId)
      .maybeSingle();
    if (error) throw error;
    if (profile?.email) await dependencies.sendEmail({ to: profile.email, ...email });
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

function subscriptionSnapshotRow(
  dependencies: StripeWebhookDependencies,
  subscription: Stripe.Subscription,
  eventCreatedAt: string,
) {
  const resolved = dependencies.planFromSubscription(subscription);
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
