/**
 * Campaign launch (the builder creating a real, PAUSED campaign) ships dark.
 * CAMPAIGN_LAUNCH_ENABLED=true turns on:
 *  - the launch-only additions to the builder prompt,
 *  - POST /api/launch/plan and the launch plan card in the approval centre,
 *  - the `launch_campaign` branch of the recommendation executor.
 * Anything else, or absent, leaves every code path exactly as it was.
 */
export function campaignLaunchEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.CAMPAIGN_LAUNCH_ENABLED === 'true';
}

export const LAUNCH_OPERATION = 'launch_campaign';

/**
 * Performance Max launch ships dark behind its own switch, on top of
 * CAMPAIGN_LAUNCH_ENABLED. CAMPAIGN_LAUNCH_PMAX_ENABLED=true:
 *  - lifts the `pmax_assets_required` blocker when the plan carries a complete
 *    asset group (text, images, logo),
 *  - lets validateStoredPlan accept and buildLaunchOperations build a PMAX plan,
 *  - reads the account's image/video/audience inventory when proposing.
 * Anything else, or absent, leaves PMAX plans exactly as they were: built for
 * the preview and blocked.
 */
export function campaignLaunchPmaxEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return campaignLaunchEnabled(env) && env.CAMPAIGN_LAUNCH_PMAX_ENABLED === 'true';
}
