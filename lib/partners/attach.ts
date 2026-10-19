import type { NextRequest } from 'next/server';
import { normalizePartnerCode, partnersEnabled, REF_COOKIE } from './config';
import { recordPartnerReferral, type ReferralResult } from './store';
import { createAdminClient } from '@/lib/supabase/server';

export type AttachOutcome = ReferralResult | 'off' | 'no_cookie' | 'error';

/**
 * Called once, when a registration is completed: ties the new user to the
 * partner whose link they came through (the mz_ref cookie). It never throws and
 * never blocks the sign-up: a failed attempt is logged and the person registers
 * normally. The code is also kept on the auth user's metadata by /api/register
 * (`reg.ref`), so an attach that failed can be repaired by hand from ops.
 */
export async function attachReferralFromRequest(
  req: NextRequest,
  userId: string,
  deps: {
    enabled?: boolean;
    record?: (userId: string, code: string, via: 'link') => Promise<ReferralResult>;
  } = {},
): Promise<AttachOutcome> {
  if (!(deps.enabled ?? partnersEnabled())) return 'off';
  const code = normalizePartnerCode(req.cookies.get(REF_COOKIE)?.value);
  if (!code) return 'no_cookie';
  try {
    const record = deps.record ?? ((id, c, via) => recordPartnerReferral(createAdminClient(), id, c, via));
    return await record(userId, code, 'link');
  } catch (error) {
    console.error('[partners] attach referral failed', error instanceof Error ? error.message : 'unknown');
    return 'error';
  }
}
