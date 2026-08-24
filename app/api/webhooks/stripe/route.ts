import { createStripeWebhookHandler } from '@/lib/billing/stripe-webhook-handler';

export const runtime = 'nodejs';
// This handler makes a Stripe round trip plus several Supabase writes. On the
// platform default (10-15s) it could be killed mid-flight, leaving the event
// row stuck in `processing`.
export const maxDuration = 60;

export const POST = createStripeWebhookHandler();
