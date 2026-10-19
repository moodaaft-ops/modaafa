/** Offer and response coaching (gap item 46). Ships dark. */
export function offerCoachingEnabled(env: Record<string, string | undefined> = process.env) {
  return env.OFFER_COACHING_ENABLED === 'true';
}
