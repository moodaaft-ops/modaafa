import { getGoogleAdsErrorCodes } from '@/lib/google-ads/client';

/**
 * True when Google refused the token because the chosen Google account has no
 * Google Ads account at all (`AuthenticationError.NOT_ADS_USER`, HTTP 401).
 *
 * `listAccessibleCustomers` throws this before discovery can return an empty
 * list, so the OAuth callback never reached its `no_accounts` branch and the
 * user saw the generic "app not verified" failure instead.
 */
export function isNotAdsUserError(error: unknown) {
  return getGoogleAdsErrorCodes(error).includes('NOT_ADS_USER');
}
