import { CALL_HOURS_WINDOWS } from '../setup/adaptive/answers';
import { extraAccessToken } from '../google-auth/incremental';
import { isGbpReadEnabled } from '../google-auth/features';
import { loadGrant } from '../google-auth/store';
import { answeringSpan, discoverGbpLocation, gbpHoursEvidence, readGbpProfile } from './gbp';

/**
 * One Arabic line about the Business Profile hours for the call-hours decision.
 * Evidence only: it is shown next to the decision and never changes it. Returns
 * null on every failure (flag off, no grant, API not approved, several places).
 */
export async function loadGbpHoursEvidence(args: {
  db: any;
  userId: string;
  callHoursChoice: string | null;
  fetchImpl?: typeof fetch;
}): Promise<string | null> {
  if (!isGbpReadEnabled() || !args.callHoursChoice) return null;
  try {
    const grant = await loadGrant(args.db, args.userId, 'gbp');
    if (!grant) return null;
    const token = await extraAccessToken(grant.refreshToken);
    const where = await discoverGbpLocation(token, args.fetchImpl);
    if (!where) return null;
    const profile = await readGbpProfile({ accessToken: token, locationId: where.locationId, accountId: where.accountId, fetchImpl: args.fetchImpl });
    return gbpHoursEvidence(profile.periods, answeringSpan(CALL_HOURS_WINDOWS[args.callHoursChoice]))?.text ?? null;
  } catch {
    return null;
  }
}
