import { isConfiguredEnv } from '@/lib/platform/env';

type Env = Record<string, string | undefined>;

/** Paths that need Stripe.js, its frames and its API origin in the CSP. */
export const ARABIC_CHECKOUT_PATH = '/billing/pay';

/** `true` and `1` switch it on. Anything else, including a missing variable, is off. */
export function isArabicCheckoutFlagOn(env: Env = process.env) {
  const value = env.ARABIC_CHECKOUT_ENABLED?.trim().toLowerCase();
  return value === 'true' || value === '1';
}

/**
 * The browser key. It is read on the server and handed to the page as a prop, so
 * the existing `STRIPE_PUBLISHABLE_KEY` works as it is; `NEXT_PUBLIC_...` is
 * accepted too. A secret key here would be a leak, so only `pk_` is accepted.
 */
export function stripePublishableKey(env: Env = process.env) {
  const key = env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || env.STRIPE_PUBLISHABLE_KEY;
  return isConfiguredEnv(key) && key.trim().startsWith('pk_') ? key.trim() : null;
}

/**
 * A Vercel Preview must never move real money. The page is off there unless BOTH
 * keys are test keys, so a preview that was wired to live keys by mistake shows
 * the old hosted page instead of taking a live card on an unreviewed build.
 */
function previewKeysAreTestOnly(env: Env) {
  if (env.VERCEL_ENV !== 'preview') return true;
  return (
    stripePublishableKey(env)?.startsWith('pk_test_') === true &&
    env.STRIPE_SECRET_KEY?.trim().startsWith('sk_test_') === true
  );
}

/**
 * The Arabic page is offered only when the flag is on AND the browser key is
 * there. With either missing the billing and onboarding pages keep posting to
 * the hosted Stripe Checkout exactly as before, so a half-configured preview can
 * never strand a customer on a page that cannot take a card.
 */
export function isArabicCheckoutAvailable(env: Env = process.env) {
  return isArabicCheckoutFlagOn(env) && stripePublishableKey(env) !== null && previewKeysAreTestOnly(env);
}
