import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { describeError } from '@/lib/supabase/query-errors';
import { hasValidCronAuthorization } from '@/lib/security/cron-auth';
import { loadProvisioningContext } from '@/lib/provisioning/credentials';
import { unlinkAfterAcceptEnabled } from '@/lib/provisioning/flag';
import { sweepProvisions } from '@/lib/provisioning/service';
import { supabaseProvisionStore } from '@/lib/provisioning/store';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Hourly: finish stale `creating` rows, look at every open invitation, mark the
 * accepted and the expired, and release the accepted ones when
 * PROVISIONING_UNLINK_AFTER_ACCEPT=true. Same CRON_SECRET guard as the other
 * crons. Harmless while the feature is not set up: with no PROVISIONING_MCC_ID
 * or no stored token it answers 200 {"skipped":"not_configured"} and touches nothing.
 */
export async function GET(req: NextRequest) {
  if (!hasValidCronAuthorization(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let admin;
  try {
    admin = createAdminClient();
  } catch (error) {
    return NextResponse.json({ error: 'service_role_missing', message: describeError(error) }, { status: 503 });
  }

  try {
    const ads = await loadProvisioningContext(admin);
    if (!ads) return NextResponse.json({ skipped: 'not_configured' });

    const summary = await sweepProvisions({ store: supabaseProvisionStore(admin), ads, unlinkAfterAccept: unlinkAfterAcceptEnabled() });
    return NextResponse.json({ ok: true, ...summary });
  } catch (error) {
    console.error('provisioning sweep failed', error);
    return NextResponse.json({ error: 'sweep_failed', message: describeError(error) }, { status: 500 });
  }
}
