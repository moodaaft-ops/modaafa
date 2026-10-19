import { NextRequest, NextResponse } from 'next/server';
import type Stripe from 'stripe';
import { createAdminClient } from '@/lib/supabase/server';
import {
  cancelStripeSubscriptionImmediately,
  constructWebhookEvent,
  planFromSubscription,
  retrieveStripeCharge,
  retrieveStripeInvoice,
  retrieveStripeSubscription,
} from '@/lib/billing/stripe';
import {
  paymentFailedEmail,
  sendEmail,
  sendOpsAlert,
  subscriptionWelcomeEmail,
  trialEndingEmail,
  type TransactionalMail,
  type TransactionalRecipient,
} from '@/lib/notifications/email';
import { recordTrialGrant } from '@/lib/billing/checkout-policy';
import { enforceTrialCardUniquenessLive } from '@/lib/billing/trial-card-guard';
import { enforceTrialStartAccountLockLive } from '@/lib/billing/trial-start-account-lock';
import { runTrialStartGuards } from '@/lib/billing/trial-start-guards';
import {
  applySubscriptionEvent,
  subscriptionEventWasApplied,
} from '@/lib/billing/subscription-events';
import { recordPaidInvoice } from '@/lib/billing/invoices';
import { partnersEnabled } from '@/lib/partners/config';
import { accrueInvoiceCommission, voidInvoiceCommission } from '@/lib/partners/store';
import {
  arabicWelcomeIdempotencyKey,
  isArabicWelcomeMoment,
  isUnactivatedArabicSubscription,
} from '@/lib/billing/arabic-checkout/source';
import { recordUserEvent } from '@/lib/stages/events';
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
  retrieveStripeCharge,
  retrieveStripeInvoice,
  cancelStripeSubscriptionImmediately,
  paymentFailedEmail,
  sendEmail,
  sendOpsAlert,
  subscriptionWelcomeEmail,
  trialEndingEmail,
  recordTrialGrant,
  enforceTrialCardUniqueness: enforceTrialCardUniquenessLive,
  enforceTrialStartAccountLock: enforceTrialStartAccountLockLive,
  applySubscriptionEvent,
  subscriptionEventWasApplied,
  recordPaidInvoice,
  accrueInvoiceCommission,
  voidInvoiceCommission,
  recordUserEvent,
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

          // One free trial per card. A trial started on a card another user
          // already trialed with is cancelled in Stripe, written here as
          // canceled (so it never grants access, not even until the follow-up
          // customer.subscription.deleted event lands) and gets no welcome
          // email. The trial still counts as USED for the user, so the
          // next checkout starts a paid subscription instead of another trial
          // that would be refused the same way.
          //
          // The Google Ads accounts get the same treatment: a trial that starts
          // while only accounts used for someone else's trial are linked is
          // cancelled here too (and those accounts parked). The card guard goes
          // first and the account lock is skipped once it has cancelled.
          const trialGuards = await runTrialStartGuards({
            admin: supabase,
            userId,
            subscription: stripeSubscription,
            enforceCard: dependencies.enforceTrialCardUniqueness,
            enforceAccountLock: dependencies.enforceTrialStartAccountLock,
          });
          const trialBlocked = trialGuards.blocked;
          const status = trialBlocked
            ? 'canceled'
            : normalizeSubscriptionStatus(stripeSubscription.status);

          const writeResult = await dependencies.applySubscriptionEvent(supabase, {
            user_id: userId,
            plan: resolved.plan,
            billing_period: resolved.period,
            status,
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
              status === 'canceled'
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
          if (dependencies.subscriptionEventWasApplied(writeResult) && !trialBlocked) {
            await safeUserEmail(dependencies, supabase, userId, (recipient) =>
              dependencies.subscriptionWelcomeEmail(
                recipient,
                stripeSubscription.trial_end ? stripeTimestamp(stripeSubscription.trial_end) : null,
              ),
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
          // A subscription from the Arabic checkout whose first payment is still
          // with the bank is not a customer yet. `incomplete` would be written as
          // past_due, which this table counts as live. The row is written when the
          // payment clears: by the finalize route or by the update event after it.
          if (isUnactivatedArabicSubscription(subscription)) break;
          const userId =
            subscription.metadata?.userId ?? eventSubscription.metadata?.userId;
          const resolved = dependencies.planFromSubscription(subscription);

          // The subscription-created event is the first place a trial exists
          // with its card attached, and checkout.session.completed can arrive
          // late or never, so the card guard runs here too (it is idempotent).
          //
          // The Google Ads account lock runs here too, for the same reason: this
          // event is where the trial first exists, whichever of the two events
          // arrives first. Both guards are idempotent.
          const trialBlocked =
            event.type === 'customer.subscription.created' && userId
              ? (
                  await runTrialStartGuards({
                    admin: supabase,
                    userId,
                    subscription,
                    enforceCard: dependencies.enforceTrialCardUniqueness,
                    enforceAccountLock: dependencies.enforceTrialStartAccountLock,
                  })
                ).blocked
              : false;
          const status = trialBlocked
            ? 'canceled'
            : normalizeSubscriptionStatus(subscription.status);
          const row = {
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
            last_event_at: eventCreatedAt,
            canceled_at:
              status === 'canceled'
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
          // The Arabic checkout has no checkout.session.completed, so its welcome
          // email is sent from here, once, when the subscription first goes live.
          if (
            userId &&
            !trialBlocked &&
            dependencies.subscriptionEventWasApplied(writeResult) &&
            isArabicWelcomeMoment({
              eventType: event.type,
              subscription,
              previousAttributes: (event.data as { previous_attributes?: { status?: string | null } })
                .previous_attributes,
            })
          ) {
            await safeUserEmail(
              dependencies,
              supabase,
              userId,
              (recipient) =>
                dependencies.subscriptionWelcomeEmail(
                  recipient,
                  subscription.trial_end ? stripeTimestamp(subscription.trial_end) : null,
                ),
              arabicWelcomeIdempotencyKey(subscription.id),
            );
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
            // The email says the plan "renews automatically". A customer who
            // already cancelled would read that as the cancel having failed,
            // so read the live state and stay quiet for them.
            let cancelScheduled = Boolean(subscription.cancel_at_period_end || subscription.cancel_at);
            try {
              const live = await dependencies.retrieveStripeSubscription(subscription.id);
              cancelScheduled = Boolean(live.cancel_at_period_end || live.cancel_at);
            } catch (error) {
              console.error('Could not confirm cancellation state before the trial-ending email', error);
            }
            if (!cancelScheduled) {
              await safeUserEmail(dependencies, supabase, trialing.user_id, (recipient) =>
                dependencies.trialEndingEmail(stripeTimestamp(subscription.trial_end), recipient),
              );
            }
          }
          break;
        }

        // Disputes. NOTE: the Stripe webhook endpoint should have
        // `charge.dispute.created` enabled. It is in RECOMMENDED_WEBHOOK_EVENTS in
        // lib/billing/stripe.ts, so /api/health lists it as
        // `webhook.missing_recommended_events` but stays launch_ready without it
        // (deliberately NOT in REQUIRED_WEBHOOK_EVENTS). A customer who disputes a
        // charge keeps using the product while the dispute runs unless the
        // subscription ends, and the dispute fee is lost either way.
        case 'charge.dispute.created': {
          const dispute = event.data.object as any;
          const disputeId = stripeObjectId(dispute?.id);
          const chargeId = stripeObjectId(dispute?.charge);
          const ids = { event_id: event.id, dispute_id: disputeId, charge_id: chargeId };

          // A `warning_*` status is a bank inquiry (an early warning), not a
          // dispute yet: no money has moved and no fee is charged. Cancelling a
          // customer over a question is wrong, so ops are told and nothing else
          // happens. If it turns into a real dispute Stripe sends another
          // charge.dispute.created for it.
          if (isDisputeInquiry(dispute?.status)) {
            await safeOpsAlert(dependencies, {
              subject: 'استفسار من البنك على دفعة',
              message:
                'وصل استفسار مبكر من البنك على دفعة في Stripe وهو ليس نزاعاً بعد. لم يُلغَ أي اشتراك، وراجع الاستفسار في لوحة Stripe.',
              details: { ...ids, status: String(dispute.status) },
            });
            break;
          }

          // A real dispute takes the money back, so the commission on it goes too.
          if (partnersEnabled()) {
            await partnerStep('void disputed commission', async () => {
              const key = await chargeInvoiceKey(dependencies, dispute?.charge);
              if (key) await dependencies.voidInvoiceCommission(supabase, key, 'dispute', true);
            });
          }

          const subscriptionId = await resolveDisputedSubscriptionId(dependencies, dispute);
          if (!subscriptionId) {
            // No subscription on the invoice (or no invoice): a one-off charge
            // or something we cannot tie to a plan. There is nothing safe to
            // cancel, and guessing from the customer could hit the wrong one.
            await safeOpsAlert(dependencies, {
              subject: 'نزاع على دفعة بلا اشتراك معروف',
              message:
                'وصل نزاع على دفعة في Stripe ولم نصل إلى اشتراك مرتبط به. لم يُلغَ شيء ويحتاج مراجعة يدوية.',
              details: ids,
            });
            break;
          }

          // Only cancel a subscription that is ours: it has a row in our table,
          // or Stripe carries our userId on it (a row not written yet). An
          // account that shares the Stripe account but not this product is
          // never cancelled from here.
          let target = await dependencies.retrieveStripeSubscription(subscriptionId);
          const { data: localRow, error: localError } = await supabase
            .from('subscriptions')
            .select('id')
            .eq('stripe_subscription_id', subscriptionId)
            .maybeSingle();
          throwOnSupabaseError('find disputed subscription', localError);
          if (!localRow && !target.metadata?.userId) {
            await safeOpsAlert(dependencies, {
              subject: 'نزاع على اشتراك غير معروف عندنا',
              message:
                'وصل نزاع على دفعة تتبع اشتراكاً في Stripe ليس له سجل عندنا ولا يحمل معرّف مستخدم. لم يُلغَ شيء ويحتاج مراجعة يدوية.',
              details: { ...ids, subscription_id: subscriptionId },
            });
            break;
          }

          // Idempotent: a subscription that already ended is not cancelled again
          // (Stripe would reject it), but the local row and the alert still go out.
          let outcome: 'cancelled' | 'already_ended' = 'already_ended';
          if (!SUBSCRIPTION_ENDED_STATUSES.has(target.status)) {
            target = await dependencies.cancelStripeSubscriptionImmediately(subscriptionId);
            outcome = 'cancelled';
          }
          await dependencies.applySubscriptionEvent(
            supabase,
            subscriptionSnapshotRow(dependencies, target, eventCreatedAt),
          );
          await safeOpsAlert(dependencies, {
            subject: 'نزاع على دفعة وأُلغي الاشتراك',
            message:
              'وصل نزاع على دفعة في Stripe وأُلغي الاشتراك المرتبط به فوراً. راجع النزاع في لوحة Stripe وجهّز الأدلة قبل الموعد.',
            // Ids only: no names, emails or amounts.
            details: { ...ids, subscription_id: subscriptionId, outcome },
          });
          break;
        }

        case 'invoice.payment_succeeded': {
          const invoice = event.data.object as any;
          const subscriptionId = invoiceSubscriptionId(invoice);
          if (!subscriptionId) break;
          const subscription = await dependencies.retrieveStripeSubscription(subscriptionId);
          if (isUnactivatedArabicSubscription(subscription)) {
            // A paid invoice on a subscription Stripe has not yet marked active: the
            // timing gap right after 3D Secure. Skipping would lose the invoice
            // record for good, so the event is retried until the row exists.
            if (invoice.status === 'paid') {
              throw new Error('Arabic subscription is not active yet; retrying so the paid invoice is recorded');
            }
            break;
          }
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
            // "Paid" means money actually moved. Starting a trial produces a
            // zero-amount invoice that Stripe also reports as succeeded, and
            // that must not count: the user has not paid yet. Never throws.
            if ((invoice.amount_paid ?? 0) > 0) {
              await dependencies.recordUserEvent(localSubscription.user_id, 'subscription_paid', {
                admin: supabase,
                metadata: { stripe_invoice_id: invoice.id ?? null },
              });
              // The partner's commission for this payment. Never fails the event:
              // billing must not depend on the affiliate programme, and the
              // /api/cron/partner-reconcile sweep earns anything missed here.
              if (partnersEnabled()) {
                await partnerStep('accrue commission', () =>
                  dependencies.accrueInvoiceCommission(supabase, { userId: localSubscription.user_id, invoice }),
                );
              }
            }
          }
          break;
        }

        // A refund. Only listed when the endpoint sends it: without it, a refunded
        // invoice keeps its commission until someone voids it by hand from ops
        // (the dispute path below is unaffected).
        case 'charge.refunded': {
          if (!partnersEnabled()) break;
          const charge = event.data.object as any;
          const full = charge?.refunded === true || (typeof charge?.amount === 'number' && charge.amount_refunded >= charge.amount);
          await partnerStep('void refunded commission', async () => {
            const key = await chargeInvoiceKey(dependencies, charge);
            if (key) await dependencies.voidInvoiceCommission(supabase, key, 'refund', full);
          });
          break;
        }

        case 'invoice.payment_failed': {
          const invoice = event.data.object as any;
          const subscriptionId = invoiceSubscriptionId(invoice);
          if (!subscriptionId) break;
          const subscription = await dependencies.retrieveStripeSubscription(subscriptionId);
          // The first payment of a pay-now subscription failing is answered on the
          // page itself (and the subscription is closed), not by a past_due row
          // and a payment-failed email.
          if (isUnactivatedArabicSubscription(subscription)) break;
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
            await safeUserEmail(dependencies, supabase, userId, (recipient) =>
              dependencies.paymentFailedEmail(recipient),
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

/**
 * Sends one of the billing mails to the user the event belongs to.
 *
 * The user row is read once, for the address, the name (greeting) and the
 * suppression mark: a hard bounce or a spam complaint stops everything sent to
 * that address, billing mail included. If the suppression column cannot be read
 * (the lifecycle migration has not run yet) the read falls back to address and
 * name only, so billing mail never depends on the migration.
 */
async function safeUserEmail(
  dependencies: StripeWebhookDependencies,
  supabase: ReturnType<typeof createAdminClient>,
  userId: string,
  build: (recipient: TransactionalRecipient) => TransactionalMail | null,
  idempotencyKey?: string,
) {
  try {
    let { data: profile, error } = await supabase
      .from('users')
      .select('email, name, email_suppressed_at')
      .eq('id', userId)
      .maybeSingle();
    if (error) {
      ({ data: profile, error } = await supabase
        .from('users')
        .select('email, name')
        .eq('id', userId)
        .maybeSingle());
    }
    if (error) throw error;
    if (!profile?.email) return;
    if ((profile as { email_suppressed_at?: string | null }).email_suppressed_at) return;

    const mail = build({ id: userId, email: profile.email, name: (profile as { name?: string | null }).name ?? null });
    if (!mail) {
      console.error('Stripe lifecycle email has no content', { userId });
      return;
    }
    await dependencies.sendEmail({
      to: profile.email,
      ...mail,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
  } catch (error) {
    console.error('Failed to send Stripe lifecycle email', { userId, error });
  }
}

const SUBSCRIPTION_ENDED_STATUSES = new Set(['canceled', 'incomplete_expired']);

/** Stripe's inquiry statuses (`warning_needs_response`, `warning_under_review`, `warning_closed`). */
function isDisputeInquiry(status: unknown) {
  return typeof status === 'string' && status.startsWith('warning_');
}

/**
 * The subscription a disputed charge belongs to: dispute.charge -> charge.invoice
 * -> the invoice's subscription (`invoiceSubscriptionId` handles both API
 * shapes). Nothing else: a charge with no invoice, or an invoice with no
 * subscription, resolves to null and the caller only alerts. There is NO guess
 * from the customer, whose live subscription may be a different product. Lookup
 * failures throw so Stripe retries the event.
 */
async function resolveDisputedSubscriptionId(
  dependencies: StripeWebhookDependencies,
  dispute: any,
) {
  const chargeId = stripeObjectId(dispute?.charge);
  if (!chargeId) return null;
  const charge =
    dispute.charge && typeof dispute.charge === 'object'
      ? dispute.charge
      : await dependencies.retrieveStripeCharge(chargeId);

  const invoiceId = stripeObjectId(charge?.invoice);
  if (!invoiceId) return null;
  const invoice =
    charge.invoice && typeof charge.invoice === 'object'
      ? charge.invoice
      : await dependencies.retrieveStripeInvoice(invoiceId);
  return invoiceSubscriptionId(invoice);
}

/** A partner-programme step that must never fail the billing event around it. */
async function partnerStep(label: string, step: () => Promise<unknown>) {
  try {
    await step();
  } catch (error) {
    console.error(`[partners] ${label} failed`, error instanceof Error ? error.message : 'unknown');
  }
}

/** The key a commission is stored under for the invoice a charge paid: `number ?? id`, as recordPaidInvoice stores it. */
async function chargeInvoiceKey(dependencies: StripeWebhookDependencies, chargeOrId: unknown) {
  const chargeId = stripeObjectId(chargeOrId);
  if (!chargeId) return null;
  const charge =
    chargeOrId && typeof chargeOrId === 'object' && 'invoice' in (chargeOrId as object)
      ? (chargeOrId as any)
      : await dependencies.retrieveStripeCharge(chargeId);
  const invoiceId = stripeObjectId(charge?.invoice);
  if (!invoiceId) return null;
  const invoice =
    charge.invoice && typeof charge.invoice === 'object' ? charge.invoice : await dependencies.retrieveStripeInvoice(invoiceId);
  return (invoice?.number ?? invoice?.id ?? invoiceId) as string;
}

async function safeOpsAlert(
  dependencies: StripeWebhookDependencies,
  payload: Parameters<StripeWebhookDependencies['sendOpsAlert']>[0],
) {
  try {
    await dependencies.sendOpsAlert(payload);
  } catch (error) {
    // The cancellation is what matters; a lost alert must not fail the event
    // and re-run the whole handler.
    console.error('Failed to send Stripe dispute alert', error);
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

/**
 * The invoice's subscription id across Stripe API versions. The webhook
 * payload follows the ENDPOINT's API version, not the SDK pin: from the
 * 2025-03-31 (basil) versions on, `invoice.subscription` is gone and the id
 * lives under `parent.subscription_details.subscription`. Reading only the old
 * field made both invoice handlers silently `break` — no invoice recorded, no
 * payment-failed email — on a newer endpoint.
 */
export function invoiceSubscriptionId(invoice: any): string | null {
  return (
    stripeObjectId(invoice?.subscription) ??
    stripeObjectId(invoice?.parent?.subscription_details?.subscription) ??
    null
  );
}
