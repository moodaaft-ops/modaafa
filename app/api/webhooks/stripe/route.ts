import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { constructWebhookEvent } from '@/lib/billing/stripe';

/**
 * POST /api/webhooks/stripe
 *
 * Handles Stripe lifecycle events:
 * - checkout.session.completed → create subscription row
 * - customer.subscription.updated → update status, period
 * - customer.subscription.deleted → mark canceled
 * - invoice.payment_succeeded → record invoice
 * - invoice.payment_failed → mark past_due
 *
 * MUST receive raw body for signature verification.
 */
export const runtime = 'nodejs';

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

  const supabase = createAdminClient();

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as any;
      const userId = session.metadata?.userId;
      if (!userId) break;

      await supabase.from('subscriptions').insert({
        user_id: userId,
        plan: session.subscription_data?.metadata?.plan ?? 'starter',
        billing_period: session.subscription_data?.metadata?.period ?? 'monthly',
        status: 'trialing',
        stripe_subscription_id: session.subscription,
        stripe_customer_id: session.customer,
        trial_ends_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      });
      break;
    }

    case 'customer.subscription.updated': {
      const sub = event.data.object as any;
      await supabase
        .from('subscriptions')
        .update({
          status: sub.status,
          current_period_start: new Date(sub.current_period_start * 1000).toISOString(),
          current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
        })
        .eq('stripe_subscription_id', sub.id);
      break;
    }

    case 'customer.subscription.deleted': {
      const sub = event.data.object as any;
      await supabase
        .from('subscriptions')
        .update({ status: 'canceled', canceled_at: new Date().toISOString() })
        .eq('stripe_subscription_id', sub.id);
      break;
    }

    case 'invoice.payment_succeeded': {
      const invoice = event.data.object as any;
      const { data: sub } = await supabase
        .from('subscriptions')
        .select('id, user_id')
        .eq('stripe_subscription_id', invoice.subscription)
        .single();

      if (sub) {
        await supabase.from('invoices').insert({
          subscription_id: sub.id,
          user_id: sub.user_id,
          amount_sar: (invoice.amount_paid ?? 0) / 100,
          status: 'paid',
          invoice_number: invoice.number,
          invoice_url: invoice.hosted_invoice_url,
          paid_at: new Date().toISOString(),
        });
      }
      break;
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object as any;
      await supabase
        .from('subscriptions')
        .update({ status: 'past_due' })
        .eq('stripe_subscription_id', invoice.subscription);
      break;
    }
  }

  return NextResponse.json({ received: true });
}
