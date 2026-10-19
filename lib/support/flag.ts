/**
 * Rollout switch for the customer-service bot. Off (the default) means the
 * widget is not rendered, /api/support/chat answers 404, and every WhatsApp
 * button on the site stays exactly as it was.
 *
 * Both the pages and the route read it from the environment, so changing it in
 * Vercel needs a redeploy to reach the statically built public pages.
 */
export function isSupportBotEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.SUPPORT_BOT_ENABLED?.trim().toLowerCase() === 'true';
}
