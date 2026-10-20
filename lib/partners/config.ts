/**
 * Partner (affiliate) programme settings that the edge middleware, the routes and
 * the pages all need. No Node imports: middleware runs on the edge.
 *
 * The programme is OFF unless PARTNERS_ENABLED=true. Off means: no cookie is set,
 * no click is stored, no referral is recorded, no commission is earned, and the
 * checkout does nothing different. The money numbers (rates, hold, minimum) live
 * in the database table partner_settings, not here.
 */

export const REF_COOKIE = 'mz_ref';
/** Last click wins within 60 days. */
export const REF_COOKIE_MAX_AGE = 60 * 24 * 60 * 60;

export const PARTNER_CODE_PATTERN = /^[a-z0-9][a-z0-9_-]{2,31}$/;

export function partnersEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.PARTNERS_ENABLED === 'true';
}

/** The Stripe promotion code given to a referred customer, or null when none is set. */
export function refereeGiftPromoCode(env: Record<string, string | undefined> = process.env): string | null {
  const raw = env.PARTNER_REFEREE_PROMO_CODE?.trim();
  return raw ? raw : null;
}

/** A short Arabic phrase describing the gift ("20% على أول دفعة"), shown on the public page. Shown only together with the code. */
export function refereeGiftLabel(env: Record<string, string | undefined> = process.env): string | null {
  if (!refereeGiftPromoCode(env)) return null;
  const raw = env.PARTNER_REFEREE_GIFT_LABEL?.trim();
  return raw ? raw.slice(0, 80) : null;
}

/** A code as a partner would type or share it: trimmed, lower case, or null when it cannot be one. */
export function normalizePartnerCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toLowerCase();
  return PARTNER_CODE_PATTERN.test(code) ? code : null;
}

export function partnerLink(appUrl: string, code: string): string {
  return `${appUrl.replace(/\/+$/, '')}/r/${code}`;
}

export const REF_COOKIE_OPTIONS = {
  maxAge: REF_COOKIE_MAX_AGE,
  path: '/',
  sameSite: 'lax' as const,
  httpOnly: true,
};
