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
