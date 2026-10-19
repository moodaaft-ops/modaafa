import { isConfiguredEnv } from '@/lib/platform/env';

type Env = Record<string, string | undefined>;

/** Paths that need Stripe.js, its frames and its API origin in the CSP. */
export const ARABIC_CHECKOUT_PATH = '/billing/pay';

/** `true` and `1` switch it on. Anything else, including a missing variable, is off. */
export function isArabicCheckoutFlagOn(env: Env = process.env) {
  const value = env.ARABIC_CHECKOUT_ENABLED?.trim().toLowerCase();
  return value === 'true' || value === '1';
}

/** The browser key. A secret key here would be a leak, so only `pk_` is accepted. */
export function stripePublishableKey(env: Env = process.env) {
  const key = env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
  return isConfiguredEnv(key) && key.trim().startsWith('pk_') ? key.trim() : null;
}

/**
 * The Arabic page is offered only when the flag is on AND the browser key is
 * there. With either missing the billing and onboarding pages keep posting to
 * the hosted Stripe Checkout exactly as before, so a half-configured preview can
 * never strand a customer on a page that cannot take a card.
 */
export function isArabicCheckoutAvailable(env: Env = process.env) {
  return isArabicCheckoutFlagOn(env) && stripePublishableKey(env) !== null;
}
