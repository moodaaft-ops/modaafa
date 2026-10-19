import { isExtendedActionsEnabled } from '../ai/extended-actions/flag';

/**
 * ADS_STUDIO_ENABLED gates everything added by the ad copy and assets work:
 * asset performance reads, the RSA and extension writers, the new approval
 * actions (replace_rsa_assets, add_sitelinks, add_callouts, add_structured_snippet,
 * add_call_asset) and the optimizer's asset cards. Only the literal "true" turns it on.
 */
export function isAdsStudioEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.ADS_STUDIO_ENABLED === 'true';
}

/**
 * The approval actions ride on the extended-actions pipeline, so they need
 * BOTH flags. Read-only code may use isAdsStudioEnabled alone.
 */
export function isAdsStudioActive(env: Record<string, string | undefined> = process.env): boolean {
  return isAdsStudioEnabled(env) && isExtendedActionsEnabled(env);
}
